const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getSeededScoreboard } = require('./seeds/seedData');
const { createAppLogger } = require('./logger');
const { createMetrics } = require('./metrics');

const STYLES_PATH = path.join(__dirname, 'styles.css');
const APP_JS_PATH = path.join(__dirname, 'app.js');
const X_MARKER_IMAGE_PATH = path.join(__dirname, 'public', 'images', 'x.png');
const O_MARKER_IMAGE_PATH = path.join(__dirname, 'public', 'images', 'o.png');
const PACKAGE_JSON_PATH = path.join(__dirname, 'package.json');
const PACKAGE_METADATA = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const APP_VERSION = `v${PACKAGE_METADATA.version}`;
let hasLoggedMissingMongoDriver = false;

function isEnabledEnvToggle(value) {
	const normalized = String(value || '').trim().toLowerCase();
	return normalized === 'true';
}

function normalizeMarkerImagesPath(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) {
		return '/images';
	}

	const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
	return withoutTrailingSlash || '/images';
}

function isHttpOrHttpsUrl(value) {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function resolveMarkerImagesPathConfig(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) {
		return {
			markerImagesPath: '/images',
			invalidConfiguredValue: null
		};
	}

	if (!isHttpOrHttpsUrl(trimmed)) {
		return {
			markerImagesPath: '/images',
			invalidConfiguredValue: trimmed
		};
	}

	return {
		markerImagesPath: normalizeMarkerImagesPath(trimmed),
		invalidConfiguredValue: null
	};
}

function escapeHtmlAttribute(value) {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function isServerStatefulModeEnabled() {
	const normalized = String(process.env.STATEFUL_MODE || '').trim().toLowerCase();
	return normalized === 'server' || normalized === 'true';
}

function getFallbackModeLabel() {
	return isServerStatefulModeEnabled() ? 'Server-side stateful' : 'Client-local stateful';
}

function getFallbackStorage() {
	return isServerStatefulModeEnabled() ? 'server-memory' : 'client-local';
}

function getMongoFallbackMessage(reason) {
	const usesServerMemory = getFallbackStorage() === 'server-memory';

	if (reason === 'driver_missing') {
		return usesServerMemory
			? 'MongoDB driver not installed; using server in-memory fallback'
			: 'MongoDB driver not installed; using client-local fallback';
	}

	return usesServerMemory
		? 'Mongo connection failed; using server in-memory fallback'
		: 'Mongo connection failed; using client-local fallback';
}

function getFooterVersionStamp() {
	const configuredTimestamp = String(process.env.APP_FOOTER_TIMESTAMP || '').trim();
	return configuredTimestamp ? `${APP_VERSION} ${configuredTimestamp}` : APP_VERSION;
}

function defaultGameState() {
	return {
		board: ['', '', '', '', '', '', '', '', ''],
		currentPlayer: 'X',
		roundNumber: 1,
		computerDifficulty: 'easy',
		score: 0,
		drawCarryPoints: 0,
		streak: 0,
		awaitingInitials: false,
		gameOver: false,
		lastRoundResult: null,
		winningLine: []
	};
}

function normalizeGameState(game) {
	if (!game || typeof game !== 'object') {
		return { ...defaultGameState() };
	}

	return {
		...defaultGameState(),
		...game,
		board: Array.isArray(game.board) && game.board.length === 9 ? game.board : defaultGameState().board,
		winningLine: Array.isArray(game.winningLine) ? game.winningLine : []
	};
}

function defaultSharedState() {
	return {
		scoreboard: [],
		gamesBySession: {}
	};
}

function normalizeSharedState(state) {
	const normalized = defaultSharedState();

	if (state && typeof state === 'object') {
		if (Array.isArray(state.scoreboard)) {
			normalized.scoreboard = state.scoreboard;
		}

		if (state.gamesBySession && typeof state.gamesBySession === 'object') {
			for (const [sessionId, game] of Object.entries(state.gamesBySession)) {
				normalized.gamesBySession[sessionId] = normalizeGameState(game);
			}
		} else if (state.game && typeof state.game === 'object') {
			normalized.gamesBySession['default-session'] = normalizeGameState(state.game);
		}
	}

	return normalized;
}

function parseCookies(cookieHeader) {
	if (!cookieHeader || typeof cookieHeader !== 'string') {
		return {};
	}

	const cookies = {};
	for (const part of cookieHeader.split(';')) {
		const [rawName, ...rawValueParts] = part.trim().split('=');
		if (!rawName) {
			continue;
		}

		const rawValue = rawValueParts.join('=');
		cookies[rawName] = decodeURIComponent(rawValue || '');
	}

	return cookies;
}

function resolveSessionId(req, res) {
	const cookies = parseCookies(req.headers.cookie);
	if (cookies.sid) {
		return cookies.sid;
	}

	const headerSessionId = req.headers['x-session-id'];
	if (typeof headerSessionId === 'string' && headerSessionId.trim()) {
		return headerSessionId.trim();
	}

	const acceptsHtml = typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html');
	if (acceptsHtml) {
		const sessionId = crypto.randomUUID();
		res.setHeader('Set-Cookie', `sid=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`);
		return sessionId;
	}

	return 'default-session';
}

function getMongoTargetForLog(mongoUri) {
	try {
		const url = new URL(mongoUri);
		const databaseName = url.pathname && url.pathname !== '/' ? url.pathname.slice(1) : '(default)';
		return `${url.host}/${databaseName}`;
	} catch {
		return 'unknown';
	}
}

function createMongoStateStore(mongoUri, { logEvent } = {}) {
	const initialSharedState = defaultSharedState();
	let fallbackState = initialSharedState;
	let sessionsCollection = null;
	let scoreboardCollection = null;
	let legacyCollection = null;
	let isClosed = false;
	let connectionState = 'pending';
	let hasLoggedFallbackActivation = false;

	const emitMongoLog = (level, payload) => {
		if (typeof logEvent === 'function') {
			logEvent(level, payload);
		}
	};

	const activateFallback = ({ message, error, reason }) => {
		connectionState = 'fallback';

		if (hasLoggedFallbackActivation) {
			return;
		}

		hasLoggedFallbackActivation = true;
		const safeMongoTarget = getMongoTargetForLog(mongoUri);
		const errorMessage = error && error.message ? error.message : String(error || 'unknown_error');
		const fallbackMode = getFallbackModeLabel();
		const fallbackStorage = getFallbackStorage();

		emitMongoLog('error', {
			code: 'MDB_002',
			message,
			reason,
			mode: fallbackMode,
			fallbackStorage,
			mongoTarget: safeMongoTarget,
			error: errorMessage
		});

		emitMongoLog('warn', {
			code: 'MDB_004',
			message: 'Mongo fallback activated',
			reason,
			mode: fallbackMode,
			fallbackStorage,
			mongoTarget: safeMongoTarget
		});
	};

	let MongoClient;
	try {
		({ MongoClient } = require('mongodb'));
	} catch {
		if (!hasLoggedMissingMongoDriver) {
			hasLoggedMissingMongoDriver = true;
			activateFallback({
				message: getMongoFallbackMessage('driver_missing'),
				error: new Error('mongodb_driver_missing'),
				reason: 'driver_missing'
			});
		}

		return {
			uri: mongoUri,
			awaitReady: async () => {},
			isMongoConnected: () => false,
			isFallbackActive: () => true,
			getState: async (sessionId) => {
				const shared = normalizeSharedState(fallbackState);
				const game = shared.gamesBySession[sessionId]
					? normalizeGameState(shared.gamesBySession[sessionId])
					: defaultGameState();

				return {
					game,
					scoreboard: shared.scoreboard
				};
			},
			getTopScores: async (limit = 10) => {
				const shared = normalizeSharedState(fallbackState);
				return [...shared.scoreboard]
					.sort((first, second) => second.score - first.score)
					.slice(0, limit);
			},
			setState: async (sessionId, nextState) => {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: Array.isArray(nextState.scoreboard) ? nextState.scoreboard : shared.scoreboard,
					gamesBySession: {
						...shared.gamesBySession,
						[sessionId]: normalizeGameState(nextState.game)
					}
				};
			},
			setGameState: async (sessionId, game) => {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					gamesBySession: {
						...shared.gamesBySession,
						[sessionId]: normalizeGameState(game)
					}
				};
			},
			replaceScoreboard: async (entries) => {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: Array.isArray(entries) ? entries : []
				};
			},
			appendScoreboardEntry: async (entry) => {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: [...shared.scoreboard, entry]
				};
			},
			close: async () => {}
		};
	}

	const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 1500 });
	const initPromise = client
		.connect()
		.then(async () => {
			connectionState = 'connected';

			if (isClosed) {
				return;
			}

			emitMongoLog('info', {
				code: 'MDB_001',
				message: 'Mongo connection established',
				mode: 'Persistent with Mongo DB',
				mongoTarget: getMongoTargetForLog(mongoUri)
			});

			const db = client.db();
			sessionsCollection = db.collection('game_sessions');
			scoreboardCollection = db.collection('scoreboard_entries');
			legacyCollection = db.collection('app_state');

			await sessionsCollection.createIndex({ updatedAt: -1 });
			await scoreboardCollection.createIndex({ score: -1, createdAt: 1 });

			const [sessionCount, scoreboardCount] = await Promise.all([
				sessionsCollection.countDocuments({}, { limit: 1 }),
				scoreboardCollection.countDocuments({}, { limit: 1 })
			]);

			if (sessionCount > 0 || scoreboardCount > 0) {
				return;
			}

			const existing = await legacyCollection.findOne({ _id: 'singleton' });
			if (!existing || !existing.state || typeof existing.state !== 'object') {
				return;
			}

			const normalized = normalizeSharedState(existing.state);
			const now = new Date();

			const sessionDocuments = Object.entries(normalized.gamesBySession).map(([sid, game]) => ({
				_id: sid,
				game: normalizeGameState(game),
				createdAt: now,
				updatedAt: now
			}));

			const scoreboardDocuments = normalized.scoreboard.map((entry, index) => ({
				initials: entry.initials,
				score: entry.score,
				createdAt: new Date(now.getTime() + index),
				updatedAt: now
			}));

			if (sessionDocuments.length > 0) {
				await sessionsCollection.insertMany(sessionDocuments, { ordered: true });
			}

			if (scoreboardDocuments.length > 0) {
				await scoreboardCollection.insertMany(scoreboardDocuments, { ordered: true });
			}
		})
		.catch((error) => {
			if (isClosed) {
				return;
			}

			activateFallback({
				message: getMongoFallbackMessage('connect_failed'),
				error,
				reason: 'connect_failed'
			});
		});

	return {
		uri: mongoUri,
		awaitReady: async () => {
			await initPromise.catch(() => {});
		},
		isMongoConnected: () => connectionState === 'connected',
		isFallbackActive: () => connectionState === 'fallback',
		getState: async (sessionId) => {
			await initPromise.catch(() => {});

			if (!sessionsCollection || !scoreboardCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				const game = shared.gamesBySession[sessionId]
					? normalizeGameState(shared.gamesBySession[sessionId])
					: defaultGameState();

				return {
					game,
					scoreboard: shared.scoreboard
				};
			}

			const [sessionDocument, scoreboardDocuments] = await Promise.all([
				sessionsCollection.findOne({ _id: sessionId }),
				scoreboardCollection.find({}, { projection: { _id: 0, initials: 1, score: 1, createdAt: 1 } })
					.sort({ createdAt: 1 })
					.toArray()
			]);

			return {
				game: sessionDocument?.game ? normalizeGameState(sessionDocument.game) : defaultGameState(),
				scoreboard: scoreboardDocuments.map((entry) => ({ initials: entry.initials, score: entry.score }))
			};
		},
		getTopScores: async (limit = 10) => {
			await initPromise.catch(() => {});

			if (!scoreboardCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				return [...shared.scoreboard]
					.sort((first, second) => second.score - first.score)
					.slice(0, limit);
			}

			const scoreboardDocuments = await scoreboardCollection
				.find({}, { projection: { _id: 0, initials: 1, score: 1 } })
				.sort({ score: -1, createdAt: 1 })
				.limit(limit)
				.toArray();

			return scoreboardDocuments.map((entry) => ({ initials: entry.initials, score: entry.score }));
		},
		setState: async (sessionId, nextState) => {
			const normalizedGame = normalizeGameState(nextState.game);
			const normalizedScoreboard = Array.isArray(nextState.scoreboard) ? nextState.scoreboard : [];
			const now = new Date();

			await initPromise.catch(() => {});

			if (!sessionsCollection || !scoreboardCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: normalizedScoreboard,
					gamesBySession: {
						...shared.gamesBySession,
						[sessionId]: normalizedGame
					}
				};
				return;
			}

			await sessionsCollection.updateOne(
				{ _id: sessionId },
				{ $set: { game: normalizedGame, updatedAt: now }, $setOnInsert: { createdAt: now } },
				{ upsert: true }
			);

			await scoreboardCollection.deleteMany({});
			if (normalizedScoreboard.length > 0) {
				await scoreboardCollection.insertMany(
					normalizedScoreboard.map((entry, index) => ({
						initials: entry.initials,
						score: entry.score,
						createdAt: new Date(now.getTime() + index),
						updatedAt: now
					})),
					{ ordered: true }
				);
			}
		},
		setGameState: async (sessionId, game) => {
			const normalizedGame = normalizeGameState(game);
			const now = new Date();

			await initPromise.catch(() => {});

			if (!sessionsCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					gamesBySession: {
						...shared.gamesBySession,
						[sessionId]: normalizedGame
					}
				};
				return;
			}

			await sessionsCollection.updateOne(
				{ _id: sessionId },
				{ $set: { game: normalizedGame, updatedAt: now }, $setOnInsert: { createdAt: now } },
				{ upsert: true }
			);
		},
		replaceScoreboard: async (entries) => {
			const normalizedEntries = Array.isArray(entries) ? entries : [];
			const now = new Date();

			await initPromise.catch(() => {});

			if (!scoreboardCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: normalizedEntries
				};
				return;
			}

			await scoreboardCollection.deleteMany({});

			if (normalizedEntries.length > 0) {
				await scoreboardCollection.insertMany(
					normalizedEntries.map((entry, index) => ({
						initials: entry.initials,
						score: entry.score,
						createdAt: new Date(now.getTime() + index),
						updatedAt: now
					})),
					{ ordered: true }
				);
			}
		},
		appendScoreboardEntry: async (entry) => {
			await initPromise.catch(() => {});

			if (!scoreboardCollection || isClosed) {
				const shared = normalizeSharedState(fallbackState);
				fallbackState = {
					...shared,
					scoreboard: [...shared.scoreboard, { initials: entry.initials, score: entry.score }]
				};
				return;
			}

			const now = new Date();
			await scoreboardCollection.insertOne({
				initials: entry.initials,
				score: entry.score,
				createdAt: now,
				updatedAt: now
			});
		},
		close: async () => {
			isClosed = true;
			await initPromise.catch(() => {});

			try {
				await client.close();
			} catch (error) {
				console.warn(`MongoDB client close failed: ${error.message}`);
			}
		}
	};
}

function defaultState() {
	return {
		game: defaultGameState(),
		scoreboard: []
	};
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';

		req.on('data', (chunk) => {
			body += chunk;
		});

		req.on('end', () => {
			if (!body) {
				resolve({});
				return;
			}

			try {
				resolve(JSON.parse(body));
			} catch (error) {
				reject(error);
			}
		});

		req.on('error', reject);
	});
}

function isValidStatePayload(payload) {
	if (!payload || typeof payload !== 'object') {
		return false;
	}

	if ('game' in payload) {
		if (!payload.game || typeof payload.game !== 'object') {
			return false;
		}

		if ('board' in payload.game) {
			if (!Array.isArray(payload.game.board) || payload.game.board.length !== 9) {
				return false;
			}

			for (const cell of payload.game.board) {
				if (cell !== '' && cell !== 'X' && cell !== 'O') {
					return false;
				}
			}

			const xCount = payload.game.board.filter((cell) => cell === 'X').length;
			const oCount = payload.game.board.filter((cell) => cell === 'O').length;
			if (!(xCount === oCount || xCount === oCount + 1)) {
				return false;
			}

			if ('currentPlayer' in payload.game) {
				if (payload.game.currentPlayer !== 'X' && payload.game.currentPlayer !== 'O') {
					return false;
				}

				if (xCount === oCount && payload.game.currentPlayer !== 'X') {
					return false;
				}

				if (xCount === oCount + 1 && payload.game.currentPlayer !== 'O') {
					return false;
				}
			}
		}
	}

	if ('scoreboard' in payload) {
		if (!Array.isArray(payload.scoreboard)) {
			return false;
		}

		for (const entry of payload.scoreboard) {
			if (!entry || typeof entry !== 'object') {
				return false;
			}

			if (typeof entry.initials !== 'string' || entry.initials.length !== 3) {
				return false;
			}

			if (!Number.isInteger(entry.score) || entry.score < 0) {
				return false;
			}
		}
	}

	return true;
}

function getRuntimeMode({ mongoStore, markerImagesPathOverride } = {}) {
	const mongoConfigured = Boolean(process.env.MONGODB_URI);
	const statefulModeValue = String(process.env.STATEFUL_MODE || '').trim().toLowerCase();
	const statefulRedisModeValue = String(process.env.STATEFUL_REDIS_MODE || '').trim().toLowerCase();
	const markerImageToggleEnabled = isEnabledEnvToggle(process.env.USE_MARKER_IMAGES);
	const markerImagesPath = normalizeMarkerImagesPath(markerImagesPathOverride ?? process.env.MARKER_IMAGES_PATH);
	const mongoConnected = Boolean(mongoConfigured
		&& mongoStore
		&& typeof mongoStore.isMongoConnected === 'function'
		&& mongoStore.isMongoConnected());
	const explicitServerToggleEnabled =
		statefulModeValue === 'server'
		|| statefulModeValue === 'true'
		|| statefulRedisModeValue === 'server'
		|| statefulRedisModeValue === 'true';
	const fallbackToServerStateful = Boolean(mongoConfigured && !mongoConnected && isServerStatefulModeEnabled());
	const statefulToggleEnabled = !mongoConnected
		&& (mongoConfigured ? fallbackToServerStateful : explicitServerToggleEnabled);
	const clientLocalStateful = !mongoConnected && !statefulToggleEnabled;
	const modeLabel = mongoConnected
		? 'Persistent with Mongo DB'
		: (statefulToggleEnabled ? 'Server-side stateful' : 'Client-local stateful');

	return {
		mongoConfigured,
		mongoConnected,
		statefulToggleEnabled,
		markerImageToggleEnabled,
		markerImagesPath,
		clientLocalStateful,
		isPersistent: mongoConnected || statefulToggleEnabled,
		modeLabel
	};
}

function getTopTenScores(state) {
	return [...state.scoreboard]
		.sort((first, second) => second.score - first.score)
		.slice(0, 10);
}

function getScoreboardTitle(mode) {
	if (mode.mongoConnected) {
		return 'Global Scoreboard';
	}

	if (mode.statefulToggleEnabled) {
		return 'Server Scoreboard';
	}

	return 'Local Scoreboard';
}

function getWinningLine(board, token) {
	const winningLines = [
		[0, 1, 2],
		[3, 4, 5],
		[6, 7, 8],
		[0, 3, 6],
		[1, 4, 7],
		[2, 5, 8],
		[0, 4, 8],
		[2, 4, 6]
	];

	for (const line of winningLines) {
		const [a, b, c] = line;
		if (board[a] === token && board[b] === token && board[c] === token) {
			return line;
		}
	}

	return null;
}

function getAvailableMoveIndexes(board) {
	const indexes = [];
	for (let index = 0; index < board.length; index += 1) {
		if (board[index] === '') {
			indexes.push(index);
		}
	}
	return indexes;
}

function pickRandomMoveIndex(indexes) {
	if (indexes.length === 0) {
		return -1;
	}

	const randomIndex = Math.floor(Math.random() * indexes.length);
	return indexes[randomIndex];
}

function getComputerDifficultyForRound(roundNumber) {
	if (roundNumber <= 1) {
		return 'easy';
	}

	if (roundNumber <= 3) {
		return 'medium';
	}

	return 'hard';
}

function getImmediateMoveIndex(board, token) {
	const availableMoveIndexes = getAvailableMoveIndexes(board);
	for (const index of availableMoveIndexes) {
		board[index] = token;
		const wins = Boolean(getWinningLine(board, token));
		board[index] = '';

		if (wins) {
			return index;
		}
	}

	return -1;
}

function getMediumMoveIndex(board) {
	const winningMoveIndex = getImmediateMoveIndex(board, 'O');
	if (winningMoveIndex !== -1) {
		return winningMoveIndex;
	}

	const blockingMoveIndex = getImmediateMoveIndex(board, 'X');
	if (blockingMoveIndex !== -1) {
		return blockingMoveIndex;
	}

	if (board[4] === '') {
		return 4;
	}

	const cornerIndexes = [0, 2, 6, 8].filter((index) => board[index] === '');
	if (cornerIndexes.length > 0) {
		return pickRandomMoveIndex(cornerIndexes);
	}

	return pickRandomMoveIndex(getAvailableMoveIndexes(board));
}

function scoreBoardForHardDifficulty(board, depth) {
	if (getWinningLine(board, 'O')) {
		return 10 - depth;
	}

	if (getWinningLine(board, 'X')) {
		return depth - 10;
	}

	if (isBoardFull(board)) {
		return 0;
	}

	return null;
}

function minimax(board, depth, isMaximizing) {
	const terminalScore = scoreBoardForHardDifficulty(board, depth);
	if (terminalScore !== null) {
		return terminalScore;
	}

	const availableMoveIndexes = getAvailableMoveIndexes(board);

	if (isMaximizing) {
		let bestScore = -Infinity;
		for (const index of availableMoveIndexes) {
			board[index] = 'O';
			const score = minimax(board, depth + 1, false);
			board[index] = '';
			bestScore = Math.max(bestScore, score);
		}
		return bestScore;
	}

	let bestScore = Infinity;
	for (const index of availableMoveIndexes) {
		board[index] = 'X';
		const score = minimax(board, depth + 1, true);
		board[index] = '';
		bestScore = Math.min(bestScore, score);
	}
	return bestScore;
}

function getHardMoveIndex(board) {
	const availableMoveIndexes = getAvailableMoveIndexes(board);
	if (availableMoveIndexes.length === 0) {
		return -1;
	}

	let bestScore = -Infinity;
	let bestMoveIndex = availableMoveIndexes[0];

	for (const index of availableMoveIndexes) {
		board[index] = 'O';
		const score = minimax(board, 0, false);
		board[index] = '';

		if (score > bestScore) {
			bestScore = score;
			bestMoveIndex = index;
		}
	}

	return bestMoveIndex;
}

function getComputerMoveIndex(board, difficulty) {
	if (difficulty === 'hard') {
		return getHardMoveIndex(board);
	}

	if (difficulty === 'medium') {
		return getMediumMoveIndex(board);
	}

	return pickRandomMoveIndex(getAvailableMoveIndexes(board));
}

function isBoardFull(board) {
	return board.every((cell) => cell !== '');
}

function createServer({ port = 3000, logger, metrics } = {}) {
	let statefulInMemoryState = defaultSharedState();
	let mongoStateStore = null;
	const appLogger = logger || createAppLogger();
	const appMetrics = metrics || createMetrics();

	const logEvent = (level, payload) => {
		if (!appLogger || typeof appLogger[level] !== 'function') {
			return;
		}

		appLogger[level](payload);
	};

	const markerImagesPathConfig = resolveMarkerImagesPathConfig(process.env.MARKER_IMAGES_PATH);
	if (markerImagesPathConfig.invalidConfiguredValue) {
		logEvent('warn', {
			code: 'CFG_001',
			message: 'Invalid MARKER_IMAGES_PATH; using /images fallback',
			reason: 'invalid_marker_images_path',
			configuredValue: markerImagesPathConfig.invalidConfiguredValue
		});
	}

	const getMongoStateStore = () => {
		const mongoUri = process.env.MONGODB_URI;
		if (!mongoUri) {
			return null;
		}

		if (!mongoStateStore || mongoStateStore.uri !== mongoUri) {
			mongoStateStore = createMongoStateStore(mongoUri, { logEvent });
		}

		return mongoStateStore;
	};

	const getInMemorySharedState = (mode) => {
		if (mode.statefulToggleEnabled) {
			return normalizeSharedState(statefulInMemoryState);
		}

		return defaultSharedState();
	};

	const setInMemorySharedState = (mode, nextSharedState) => {
		const normalizedSharedState = normalizeSharedState(nextSharedState);

		if (mode.statefulToggleEnabled) {
			statefulInMemoryState = normalizedSharedState;
		}
	};

	const getInMemoryActiveState = (mode, sessionId) => {
		const sharedState = getInMemorySharedState(mode);
		const game = sharedState.gamesBySession[sessionId]
			? normalizeGameState(sharedState.gamesBySession[sessionId])
			: defaultGameState();

		return {
			game,
			scoreboard: sharedState.scoreboard
		};
	};

	const setInMemoryActiveState = (mode, sessionId, nextState) => {
		const sharedState = getInMemorySharedState(mode);
		const nextSharedState = {
			...sharedState,
			scoreboard: Array.isArray(nextState.scoreboard) ? nextState.scoreboard : sharedState.scoreboard,
			gamesBySession: {
				...sharedState.gamesBySession,
				[sessionId]: normalizeGameState(nextState.game)
			}
		};

		setInMemorySharedState(mode, nextSharedState);
	};

	const server = http.createServer((req, res) => {
		void (async () => {
			const requestStartHr = process.hrtime.bigint();
			const requestPath = String(req.url || '/').split('?')[0] || '/';
			const method = req.method || 'GET';
			const correlationIdHeader = req.headers['x-correlation-id'];
			const correlationId = typeof correlationIdHeader === 'string' && correlationIdHeader.trim()
				? correlationIdHeader.trim()
				: crypto.randomUUID();
			res.setHeader('x-correlation-id', correlationId);

			const sessionId = resolveSessionId(req, res);
			const configuredMode = getRuntimeMode({ markerImagesPathOverride: markerImagesPathConfig.markerImagesPath });
			const mongoStore = configuredMode.mongoConfigured ? getMongoStateStore() : null;
			if (mongoStore && typeof mongoStore.awaitReady === 'function') {
				await mongoStore.awaitReady();
			}
			const mode = getRuntimeMode({
				mongoStore,
				markerImagesPathOverride: markerImagesPathConfig.markerImagesPath
			});
			const useMongoStore = Boolean(mongoStore && mode.mongoConnected);
			const scoreboardTitle = getScoreboardTitle(mode);

			logEvent('info', {
				code: 'REQ_100',
				message: 'Request received',
				method,
				route: requestPath,
				mode: mode.modeLabel,
				correlationId,
				sessionId
			});

			res.on('finish', () => {
				const durationMs = Number(process.hrtime.bigint() - requestStartHr) / 1_000_000;

				logEvent('info', {
					code: 'REQ_200',
					message: 'Request completed',
					method,
					route: requestPath,
					statusCode: res.statusCode,
					durationMs,
					mode: mode.modeLabel,
					correlationId,
					sessionId
				});

				appMetrics.observeRequest({
					route: requestPath,
					method,
					statusCode: res.statusCode,
					mode: mode.modeLabel,
					durationMs
				});
			});

			if (req.url === '/metrics' && req.method === 'GET') {
				const metricsPayload = await appMetrics.render();
				res.writeHead(200, { 'Content-Type': appMetrics.contentType });
				res.end(metricsPayload);
				return;
			}

			const getActiveState = async () => {
				if (useMongoStore) {
					return mongoStore.getState(sessionId);
				}

				if (mode.clientLocalStateful) {
					return defaultState();
				}

				return getInMemoryActiveState(mode, sessionId);
			};

			const setActiveState = async (nextState) => {
				if (useMongoStore) {
					await mongoStore.setState(sessionId, nextState);
					return;
				}

				if (mode.clientLocalStateful) {
					return;
				}

				setInMemoryActiveState(mode, sessionId, nextState);
			};

			const setActiveGame = async (nextGame) => {
				if (useMongoStore) {
					await mongoStore.setGameState(sessionId, nextGame);
					return;
				}

				if (mode.clientLocalStateful) {
					return;
				}

				const state = getInMemoryActiveState(mode, sessionId);
				setInMemoryActiveState(mode, sessionId, {
					...state,
					game: nextGame
				});
			};

			if (req.url === '/' && req.method === 'GET') {
				const footerVersionStamp = getFooterVersionStamp();
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
				<!doctype html>
				<html lang="en">
					<head>
						<meta charset="UTF-8" />
						<meta name="viewport" content="width=device-width, initial-scale=1.0" />
						<meta name="use-marker-images" content="${mode.markerImageToggleEnabled ? 'true' : 'false'}" />
						<meta name="marker-images-path" content="${escapeHtmlAttribute(mode.markerImagesPath)}" />
						<title>Sparta App</title>
						<link rel="stylesheet" href="/styles.css" />
					</head>
					<body class="retro-shell">
						<h1 class="retro-title">Tic Tac Toe</h1>
						<div class="layout">
							<div class="game-column">
								<section class="panel">
									<div class="status-row">
										<div class="status-stack">
											<p id="status-text" class="stat-line">Loading game state...</p>
											<form id="initials-form" hidden>
												<input id="initials-input" maxlength="3" placeholder="ABC" required />
												<button type="submit">Submit Score</button>
											</form>
										</div>
										<div id="win-actions" hidden>
											<button id="play-again-btn" type="button">Continue?</button>
											<button id="quit-btn" type="button">Quit?</button>
										</div>
									</div>
									<div id="game-board">
										<button class="game-cell" type="button"></button>
									</div>
									<p class="stat-line">Score: <span id="score-value">0</span></p>
								</section>
								<section class="panel">
									<h2>${scoreboardTitle}</h2>
									<ol id="scoreboard-list"></ol>
								</section>
							</div>
						</div>
						<p class="page-footer">Copyright © 2026 Sparta Global</p>
						<p class="mode-pill">Mode: ${mode.modeLabel}</p>
						<p class="version-stamp">${escapeHtmlAttribute(footerVersionStamp)}</p>
						<script src="/app.js"></script>
					</body>
				</html>
			`);
				return;
			}

			if (req.url === '/styles.css' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
				res.end(fs.readFileSync(STYLES_PATH, 'utf8'));
				return;
			}

			if (req.url === '/app.js' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
				res.end(fs.readFileSync(APP_JS_PATH, 'utf8'));
				return;
			}

			if (req.url === '/images/x.png' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'image/png' });
				res.end(fs.readFileSync(X_MARKER_IMAGE_PATH));
				return;
			}

			if (req.url === '/images/o.png' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'image/png' });
				res.end(fs.readFileSync(O_MARKER_IMAGE_PATH));
				return;
			}

			if (req.url === '/scoreboard' && req.method === 'GET') {
				const topScores = mode.clientLocalStateful
					? []
					: (useMongoStore
						? await mongoStore.getTopScores(10)
						: getTopTenScores(getInMemoryActiveState(mode, sessionId)));
				const scoreWidth = topScores.reduce((maxWidth, entry) => {
					return Math.max(maxWidth, String(entry.score).length);
				}, 0);
				const listItems = topScores.length > 0
					? topScores
						.map((entry) => `<li>${entry.initials}  ${String(entry.score).padStart(scoreWidth, ' ')}</li>`)
						.join('')
					: '<li>No scores yet</li>';
				const localScoreboardScript = mode.clientLocalStateful
					? `<script>
						(function renderLocalScoreboard() {
							const list = document.getElementById('scoreboard-list');
							if (!list) {
								return;
							}

							let entries = [];
							try {
								const raw = localStorage.getItem('ttt_scoreboard_v1');
								if (raw) {
									const parsed = JSON.parse(raw);
									if (Array.isArray(parsed)) {
										entries = parsed
											.filter((entry) => entry && typeof entry.initials === 'string' && Number.isInteger(entry.score))
											.map((entry) => ({ initials: entry.initials, score: entry.score }));
									}
								}
							} catch {
								entries = [];
							}

							entries = entries
								.sort((first, second) => second.score - first.score)
								.slice(0, 10);

							list.innerHTML = '';
							if (entries.length === 0) {
								const li = document.createElement('li');
								li.textContent = 'No scores yet';
								list.appendChild(li);
								return;
							}

							const scoreWidth = entries.reduce((maxWidth, entry) => {
								return Math.max(maxWidth, String(entry.score).length);
							}, 0);

							for (const entry of entries) {
								const li = document.createElement('li');
								li.textContent = entry.initials + '  ' + String(entry.score).padStart(scoreWidth, ' ');
								list.appendChild(li);
							}
						}());
					</script>`
					: '';

				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
				<!doctype html>
				<html lang="en">
					<head>
						<meta charset="UTF-8" />
						<meta name="viewport" content="width=device-width, initial-scale=1.0" />
						<title>Scoreboard</title>
						<link rel="stylesheet" href="/styles.css" />
					</head>
					<body class="retro-shell">
						<section class="panel scoreboard-panel">
							<h2>${scoreboardTitle}</h2>
							<ol id="scoreboard-list">${listItems}</ol>
							<p><a href="/">Back to Game</a></p>
						</section>
						${localScoreboardScript}
					</body>
				</html>
			`);
				return;
			}

			if (req.url === '/api/scoreboard' && req.method === 'GET') {
				const topScores = useMongoStore
					? await mongoStore.getTopScores(10)
					: getTopTenScores(getInMemoryActiveState(mode, sessionId));
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify(topScores));
				return;
			}

			if (req.url === '/api/state' && req.method === 'GET') {
				const activeState = await getActiveState();
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify(activeState));
				return;
			}

			if (req.url === '/api/state' && req.method === 'POST') {
				try {
					const payload = await readJsonBody(req);
					if (!isValidStatePayload(payload)) {
						appMetrics.observeValidationFailure({
							endpoint: requestPath,
							reason: 'invalid_state_payload',
							mode: mode.modeLabel
						});

						logEvent('warn', {
							code: 'REQ_400',
							message: 'Invalid state payload',
							reason: 'invalid_state_payload',
							method,
							route: requestPath,
							mode: mode.modeLabel,
							correlationId,
							sessionId
						});
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Invalid state payload' }));
						return;
					}

					const activeState = await getActiveState();
					const hasGamePayload = Boolean(payload.game && typeof payload.game === 'object');
					const mergedGame = hasGamePayload
						? {
							...activeState.game,
							...payload.game
						}
						: activeState.game;

					if (hasGamePayload && Object.prototype.hasOwnProperty.call(payload.game, 'board')) {
						if (!Object.prototype.hasOwnProperty.call(payload.game, 'awaitingInitials')) {
							mergedGame.awaitingInitials = false;
						}

						if (!Object.prototype.hasOwnProperty.call(payload.game, 'gameOver')) {
							mergedGame.gameOver = false;
						}

						if (!Object.prototype.hasOwnProperty.call(payload.game, 'lastRoundResult')) {
							mergedGame.lastRoundResult = null;
						}

						if (!Object.prototype.hasOwnProperty.call(payload.game, 'winningLine')) {
							mergedGame.winningLine = [];
						}
					}

					const nextState = {
						...activeState,
						...payload,
						game: mergedGame
					};

					await setActiveState(nextState);

					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: true }));
				} catch {
					appMetrics.observeValidationFailure({
						endpoint: requestPath,
						reason: 'invalid_json_payload',
						mode: mode.modeLabel
					});

					logEvent('warn', {
						code: 'REQ_400',
						message: 'Invalid JSON payload',
						reason: 'invalid_json_payload',
						method,
						route: requestPath,
						mode: mode.modeLabel,
						correlationId,
						sessionId
					});
					res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				}
				return;
			}

			if (req.url === '/api/seed' && req.method === 'POST') {
				const seededScoreboard = getSeededScoreboard();
				if (useMongoStore) {
					await mongoStore.replaceScoreboard(seededScoreboard);
				} else {
					const activeState = await getActiveState();
					setInMemoryActiveState(mode, sessionId, {
						...activeState,
						scoreboard: seededScoreboard
					});
				}

				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ ok: true, records: seededScoreboard.length }));
				return;
			}

			if (req.url === '/api/game/move' && req.method === 'POST') {
				try {
					const payload = await readJsonBody(req);
					const activeState = await getActiveState();
					const moveIndex = payload.index;
					const nextState = {
						...activeState,
						game: {
							...activeState.game,
							board: [...activeState.game.board]
						}
					};

					if (!Number.isInteger(moveIndex) || moveIndex < 0 || moveIndex > 8) {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Invalid move index' }));
						return;
					}

					if (nextState.game.awaitingInitials || nextState.game.gameOver) {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Game is over. Submit initials first.' }));
						return;
					}

					if (nextState.game.currentPlayer !== 'X') {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Not player turn' }));
						return;
					}

					if (nextState.game.board[moveIndex] !== '') {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Cell already occupied' }));
						return;
					}

					nextState.game.board[moveIndex] = 'X';
					const roundNumber = Number.isInteger(nextState.game.roundNumber) && nextState.game.roundNumber > 0
						? nextState.game.roundNumber
						: 1;
					nextState.game.roundNumber = roundNumber;
					nextState.game.computerDifficulty = getComputerDifficultyForRound(roundNumber);
					const drawCarryPoints =
						Number.isInteger(nextState.game.drawCarryPoints) && nextState.game.drawCarryPoints > 0
							? nextState.game.drawCarryPoints
							: 0;

					const playerWinningLine = getWinningLine(nextState.game.board, 'X');
					if (playerWinningLine) {
						nextState.game.score += 100 + drawCarryPoints;
						nextState.game.drawCarryPoints = 0;
						nextState.game.streak += 1;
						nextState.game.currentPlayer = 'O';
						nextState.game.awaitingInitials = false;
						nextState.game.gameOver = true;
						nextState.game.lastRoundResult = 'win';
						nextState.game.winningLine = playerWinningLine;

						await setActiveGame(nextState.game);
						res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ roundResult: 'win', game: nextState.game }));
						return;
					}

					if (isBoardFull(nextState.game.board)) {
						nextState.game.drawCarryPoints = drawCarryPoints + 100;
						nextState.game.streak = 0;
						nextState.game.awaitingInitials = false;
						nextState.game.gameOver = true;
						nextState.game.lastRoundResult = 'draw';
						nextState.game.winningLine = [];

						await setActiveGame(nextState.game);
						res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ roundResult: 'draw', game: nextState.game }));
						return;
					}

					const computerMoveIndex = getComputerMoveIndex(nextState.game.board, nextState.game.computerDifficulty);
					if (computerMoveIndex !== -1) {
						nextState.game.board[computerMoveIndex] = 'O';
					}

					const computerWinningLine = getWinningLine(nextState.game.board, 'O');
					if (computerWinningLine) {
						nextState.game.drawCarryPoints = 0;
						nextState.game.awaitingInitials = true;
						nextState.game.gameOver = true;
						nextState.game.streak = 0;
						nextState.game.lastRoundResult = 'loss';
						nextState.game.winningLine = computerWinningLine;

						await setActiveGame(nextState.game);
						res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ roundResult: 'loss', game: nextState.game }));
						return;
					}

					if (isBoardFull(nextState.game.board)) {
						nextState.game.drawCarryPoints = drawCarryPoints + 100;
						nextState.game.streak = 0;
						nextState.game.awaitingInitials = false;
						nextState.game.gameOver = true;
						nextState.game.lastRoundResult = 'draw';
						nextState.game.winningLine = [];

						await setActiveGame(nextState.game);
						res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ roundResult: 'draw', game: nextState.game }));
						return;
					}

					await setActiveGame(nextState.game);
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ roundResult: 'continue', game: nextState.game }));
				} catch {
					logEvent('warn', {
						code: 'REQ_400',
						message: 'Invalid JSON payload',
						reason: 'invalid_json_payload',
						method,
						route: requestPath,
						mode: mode.modeLabel,
						correlationId,
						sessionId
					});
					res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				}
				return;
			}

			if (req.url === '/api/game/submit-score' && req.method === 'POST') {
				try {
					const payload = await readJsonBody(req);
					const activeState = await getActiveState();
					const initials = payload.initials;

					if (typeof initials !== 'string' || initials.length !== 3) {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Initials must be exactly 3 characters' }));
						return;
					}

					if (!activeState.game.awaitingInitials) {
						if (activeState.game.lastRoundResult === 'draw') {
							res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
							res.end(JSON.stringify({ error: 'Draw rounds cannot be submitted to scoreboard' }));
							return;
						}

						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'No completed game awaiting initials' }));
						return;
					}

					if (useMongoStore) {
						await mongoStore.appendScoreboardEntry({ initials, score: activeState.game.score });
						await mongoStore.setGameState(sessionId, defaultState().game);
					} else {
						const nextState = {
							...activeState,
							scoreboard: [...activeState.scoreboard, { initials, score: activeState.game.score }],
							game: {
								...defaultState().game
							}
						};

						setInMemoryActiveState(mode, sessionId, nextState);
					}

					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: true }));
				} catch {
					logEvent('warn', {
						code: 'REQ_400',
						message: 'Invalid JSON payload',
						reason: 'invalid_json_payload',
						method,
						route: requestPath,
						mode: mode.modeLabel,
						correlationId,
						sessionId
					});
					res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				}
				return;
			}

			if (req.url === '/api/game/next-round' && req.method === 'POST') {
				try {
					const payload = await readJsonBody(req);
					const activeState = await getActiveState();
					const action = payload.action;

					if (action !== 'play-again' && action !== 'quit') {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Invalid next-round action' }));
						return;
					}

					if (!(activeState.game.gameOver && (activeState.game.lastRoundResult === 'win' || activeState.game.lastRoundResult === 'draw'))) {
						res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
						res.end(JSON.stringify({ error: 'Next-round action is only available after a win or draw' }));
						return;
					}

					let nextState;
					if (action === 'play-again') {
						nextState = {
							...activeState,
							game: {
								...activeState.game,
								board: ['', '', '', '', '', '', '', '', ''],
								currentPlayer: 'X',
								roundNumber: activeState.game.roundNumber + 1,
								computerDifficulty: getComputerDifficultyForRound(activeState.game.roundNumber + 1),
								awaitingInitials: false,
								gameOver: false,
								lastRoundResult: null,
								winningLine: []
							}
						};
					} else {
						nextState = {
							...activeState,
							game: {
								...activeState.game,
								awaitingInitials: true,
								gameOver: true,
								lastRoundResult: 'quit',
								winningLine: []
							}
						};
					}

					await setActiveGame(nextState.game);
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ ok: true, game: nextState.game }));
				} catch {
					logEvent('warn', {
						code: 'REQ_400',
						message: 'Invalid JSON payload',
						reason: 'invalid_json_payload',
						method,
						route: requestPath,
						mode: mode.modeLabel,
						correlationId,
						sessionId
					});
					res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
				}
				return;
			}

			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Not Found');
		})().catch((error) => {
			logEvent('error', {
				code: 'REQ_500',
				message: 'Unhandled request error',
				errorMessage: error?.message || 'unknown error'
			});

			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ error: 'Internal server error' }));
			}

			if (!error || !error.message || !String(error.message).includes('headers')) {
				console.warn(`Request handler error: ${error?.message || 'unknown error'}`);
			}
		});
	});

	const originalClose = server.close.bind(server);
	server.close = (callback) => {
		return originalClose(async (error) => {
			if (mongoStateStore && typeof mongoStateStore.close === 'function') {
				await mongoStateStore.close();
			}

			if (typeof callback === 'function') {
				callback(error);
			}
		});
	};

	return server;
}

module.exports = {
	createServer
};
