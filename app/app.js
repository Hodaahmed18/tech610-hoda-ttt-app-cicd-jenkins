async function requestJson(url, options) {
	const response = await fetch(url, options);
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error || 'Request failed');
	}
	return data;
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

	const normalized = {
		...defaultGameState(),
		...game
	};

	normalized.board = Array.isArray(game.board) && game.board.length === 9
		? [...game.board]
		: [...defaultGameState().board];
	normalized.winningLine = Array.isArray(game.winningLine) ? [...game.winningLine] : [];

	return normalized;
}

function normalizeScoreboard(entries) {
	if (!Array.isArray(entries)) {
		return [];
	}

	return entries
		.filter((entry) => entry && typeof entry.initials === 'string' && Number.isInteger(entry.score))
		.map((entry) => ({ initials: entry.initials, score: entry.score }));
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

function isBoardFull(board) {
	return board.every((cell) => cell !== '');
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

function createClientLocalStore() {
	const GAME_KEY = 'ttt_game_v1';
	const SCOREBOARD_KEY = 'ttt_scoreboard_v1';

	const readGame = () => {
		const raw = sessionStorage.getItem(GAME_KEY);
		if (!raw) {
			return defaultGameState();
		}

		try {
			return normalizeGameState(JSON.parse(raw));
		} catch {
			return defaultGameState();
		}
	};

	const writeGame = (game) => {
		sessionStorage.setItem(GAME_KEY, JSON.stringify(normalizeGameState(game)));
	};

	const readScoreboard = () => {
		const raw = localStorage.getItem(SCOREBOARD_KEY);
		if (!raw) {
			return [];
		}

		try {
			return normalizeScoreboard(JSON.parse(raw));
		} catch {
			return [];
		}
	};

	const writeScoreboard = (scoreboard) => {
		localStorage.setItem(SCOREBOARD_KEY, JSON.stringify(normalizeScoreboard(scoreboard)));
	};

	const getTopScores = () => {
		return [...readScoreboard()]
			.sort((first, second) => second.score - first.score)
			.slice(0, 10);
	};

	return {
		loadState: async () => ({
			game: readGame(),
			scoreboard: getTopScores()
		}),
		loadScoreboardRows: async () => {
			const scoreboard = getTopScores();
			const scoreWidth = scoreboard.reduce((maxWidth, entry) => {
				return Math.max(maxWidth, String(entry.score).length);
			}, 0);
			return scoreboard.map((entry) => `${entry.initials}  ${String(entry.score).padStart(scoreWidth, ' ')}`);
		},
		move: async (index) => {
			const game = normalizeGameState(readGame());

			if (!Number.isInteger(index) || index < 0 || index > 8) {
				throw new Error('Invalid move index');
			}

			if (game.awaitingInitials || game.gameOver) {
				throw new Error('Game is over. Submit initials first.');
			}

			if (game.currentPlayer !== 'X') {
				throw new Error('Not player turn');
			}

			if (game.board[index] !== '') {
				throw new Error('Cell already occupied');
			}

			game.board[index] = 'X';
			const roundNumber = Number.isInteger(game.roundNumber) && game.roundNumber > 0
				? game.roundNumber
				: 1;
			game.roundNumber = roundNumber;
			game.computerDifficulty = getComputerDifficultyForRound(roundNumber);
			const drawCarryPoints = Number.isInteger(game.drawCarryPoints) && game.drawCarryPoints > 0
				? game.drawCarryPoints
				: 0;

			const playerWinningLine = getWinningLine(game.board, 'X');
			if (playerWinningLine) {
				game.score += 100 + drawCarryPoints;
				game.drawCarryPoints = 0;
				game.streak += 1;
				game.currentPlayer = 'O';
				game.awaitingInitials = false;
				game.gameOver = true;
				game.lastRoundResult = 'win';
				game.winningLine = playerWinningLine;
				writeGame(game);
				return { roundResult: 'win', game };
			}

			if (isBoardFull(game.board)) {
				game.drawCarryPoints = drawCarryPoints + 100;
				game.streak = 0;
				game.awaitingInitials = false;
				game.gameOver = true;
				game.lastRoundResult = 'draw';
				game.winningLine = [];
				writeGame(game);
				return { roundResult: 'draw', game };
			}

			const computerMoveIndex = getComputerMoveIndex(game.board, game.computerDifficulty);
			if (computerMoveIndex !== -1) {
				game.board[computerMoveIndex] = 'O';
			}

			const computerWinningLine = getWinningLine(game.board, 'O');
			if (computerWinningLine) {
				game.drawCarryPoints = 0;
				game.awaitingInitials = true;
				game.gameOver = true;
				game.streak = 0;
				game.lastRoundResult = 'loss';
				game.winningLine = computerWinningLine;
				writeGame(game);
				return { roundResult: 'loss', game };
			}

			if (isBoardFull(game.board)) {
				game.drawCarryPoints = drawCarryPoints + 100;
				game.streak = 0;
				game.awaitingInitials = false;
				game.gameOver = true;
				game.lastRoundResult = 'draw';
				game.winningLine = [];
				writeGame(game);
				return { roundResult: 'draw', game };
			}

			writeGame(game);
			return { roundResult: 'continue', game };
		},
		submitScore: async (initials) => {
			const game = normalizeGameState(readGame());

			if (typeof initials !== 'string' || initials.length !== 3) {
				throw new Error('Initials must be exactly 3 characters');
			}

			if (!game.awaitingInitials) {
				if (game.lastRoundResult === 'draw') {
					throw new Error('Draw rounds cannot be submitted to scoreboard');
				}

				throw new Error('No completed game awaiting initials');
			}

			const scoreboard = readScoreboard();
			scoreboard.push({ initials, score: game.score });
			writeScoreboard(scoreboard);
			writeGame(defaultGameState());
			return { ok: true };
		},
		nextRound: async (action) => {
			if (action !== 'play-again' && action !== 'quit') {
				throw new Error('Invalid next-round action');
			}

			const game = normalizeGameState(readGame());
			if (!(game.gameOver && (game.lastRoundResult === 'win' || game.lastRoundResult === 'draw'))) {
				throw new Error('Next-round action is only available after a win or draw');
			}

			let nextGame;
			if (action === 'play-again') {
				nextGame = {
					...game,
					board: ['', '', '', '', '', '', '', '', ''],
					currentPlayer: 'X',
					roundNumber: game.roundNumber + 1,
					computerDifficulty: getComputerDifficultyForRound(game.roundNumber + 1),
					awaitingInitials: false,
					gameOver: false,
					lastRoundResult: null,
					winningLine: []
				};
			} else {
				nextGame = {
					...game,
					awaitingInitials: true,
					gameOver: true,
					lastRoundResult: 'quit',
					winningLine: []
				};
			}

			writeGame(nextGame);
			return { ok: true, game: nextGame };
		}
	};
}

function createServerStore() {
	return {
		loadState: async () => requestJson('/api/state'),
		loadScoreboardRows: async () => {
			const scoreboard = await requestJson('/api/scoreboard');
			const scoreWidth = scoreboard.reduce((maxWidth, entry) => {
				return Math.max(maxWidth, String(entry.score).length);
			}, 0);
			return scoreboard.map((entry) => `${entry.initials}  ${String(entry.score).padStart(scoreWidth, ' ')}`);
		},
		move: async (index) => requestJson('/api/game/move', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index })
		}),
		submitScore: async (initials) => requestJson('/api/game/submit-score', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials })
		}),
		nextRound: async (action) => requestJson('/api/game/next-round', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action })
		})
	};
}

function getGameCellButton(target) {
	if (!(target instanceof Element)) {
		return null;
	}

	const maybeButton = target.closest('button.game-cell');
	if (!(maybeButton instanceof HTMLButtonElement)) {
		return null;
	}

	return maybeButton;
}

function cellLabel(value) {
	return value === '' ? ' ' : value;
}

function normalizeMarkerImagesPath(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) {
		return '/images';
	}

	if (trimmed.startsWith('/')) {
		const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
		return withoutTrailingSlash || '/images';
	}

	let parsedUrl;
	try {
		parsedUrl = new URL(trimmed);
	} catch {
		return '/images';
	}

	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		return '/images';
	}

	const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
	return withoutTrailingSlash || '/images';
}

function getMarkerImageSource(value, markerImagesPath) {
	const basePath = normalizeMarkerImagesPath(markerImagesPath);

	if (value === 'X') {
		return `${basePath}/x.png`;
	}

	if (value === 'O') {
		return `${basePath}/o.png`;
	}

	return '';
}

function isTypingTarget(target) {
	if (!(target instanceof Element)) {
		return false;
	}

	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		return true;
	}

	if (target instanceof HTMLElement && target.isContentEditable) {
		return true;
	}

	return false;
}

document.addEventListener('DOMContentLoaded', async () => {
	const boardElement = document.getElementById('game-board');
	const statusElement = document.getElementById('status-text');
	const scoreElement = document.getElementById('score-value');
	const form = document.getElementById('initials-form');
	const input = document.getElementById('initials-input');
	const scoreboardList = document.getElementById('scoreboard-list');
	const winActions = document.getElementById('win-actions');
	const playAgainButton = document.getElementById('play-again-btn');
	const quitButton = document.getElementById('quit-btn');
	const modeElement = document.querySelector('.mode-pill');
	const markerImageToggleElement = document.querySelector('meta[name="use-marker-images"]');
	const markerImagesPathElement = document.querySelector('meta[name="marker-images-path"]');
	const useMarkerImages = Boolean(
		markerImageToggleElement
		&& String(markerImageToggleElement.getAttribute('content') || '').toLowerCase() === 'true'
	);
	const markerImagesPath = normalizeMarkerImagesPath(
		markerImagesPathElement ? markerImagesPathElement.getAttribute('content') : '/images'
	);
	const isClientLocalMode = Boolean(modeElement && /Client-local stateful/i.test(modeElement.textContent || ''));
	const store = isClientLocalMode ? createClientLocalStore() : createServerStore();

	let state = await store.loadState();
	let selectedIndex = 0;
	let awaitingComputerMove = false;

	function setStatus(text, showWinActions = false) {
		statusElement.textContent = text;
		if (winActions) {
			winActions.hidden = !showWinActions;
		}
	}

	function renderBoard(game) {
		boardElement.innerHTML = '';
		const winningLine = new Set(Array.isArray(game.winningLine) ? game.winningLine : []);
		for (let index = 0; index < game.board.length; index += 1) {
			const button = document.createElement('button');
			button.className = 'game-cell';
			if (winningLine.has(index)) {
				button.classList.add('winning-cell');
			}
			if (index === selectedIndex) {
				button.classList.add('selected');
			}
			button.type = 'button';
			button.dataset.index = String(index);
			const markerValue = game.board[index];
			if (useMarkerImages && markerValue !== '') {
				const markerImage = document.createElement('img');
				markerImage.className = 'marker-image';
				markerImage.src = getMarkerImageSource(markerValue, markerImagesPath);
				markerImage.alt = markerValue;
				button.appendChild(markerImage);
			} else {
				button.textContent = cellLabel(markerValue);
			}
			button.disabled = game.board[index] !== '' || game.awaitingInitials || game.gameOver || awaitingComputerMove;
			boardElement.appendChild(button);
		}
	}

	function moveSelectionBy(offset) {
		selectedIndex = (selectedIndex + offset + 9) % 9;
		renderBoard(state.game);
	}

	async function renderScoreboard() {
		const rows = await store.loadScoreboardRows();
		scoreboardList.innerHTML = '';
		if (rows.length === 0) {
			const li = document.createElement('li');
			li.textContent = 'No scores yet';
			scoreboardList.appendChild(li);
			return;
		}
		for (const row of rows) {
			const li = document.createElement('li');
			li.textContent = row;
			scoreboardList.appendChild(li);
		}
	}

	function renderState(game) {
		renderBoard(game);
		scoreElement.textContent = String(game.score);
		if (game.awaitingInitials) {
			if (game.lastRoundResult === 'quit') {
				setStatus('You quit the run. Enter initials to save your score.');
			} else {
				setStatus('Round lost. Enter initials to save your score.');
			}
			form.hidden = false;
		} else if (game.gameOver && game.lastRoundResult === 'win') {
			setStatus('You win!', true);
			form.hidden = true;
		} else if (game.gameOver && game.lastRoundResult === 'draw') {
			const drawCarryPoints = Number.isInteger(game.drawCarryPoints) && game.drawCarryPoints > 0
				? game.drawCarryPoints
				: 100;
			setStatus(`Draw! ${drawCarryPoints} points stored up for next win.`, true);
			form.hidden = true;
		} else {
			setStatus('Your move: choose a square.');
			form.hidden = true;
		}
	}

	async function submitWinAction(action) {
		const result = await store.nextRound(action);
		state.game = result.game;
		renderState(state.game);
		await renderScoreboard();
	}

	boardElement.addEventListener('click', async (event) => {
		const button = getGameCellButton(event.target);
		if (!button || button.disabled) {
			return;
		}

		const index = Number(button.dataset.index);
		if (!Number.isInteger(index)) {
			return;
		}

		try {
			awaitingComputerMove = true;
			state.game.board[index] = 'X';
			renderBoard(state.game);
			setStatus('Computer is thinking...');
			await new Promise((resolve) => setTimeout(resolve, 300));
			const result = await store.move(index);
			state.game = result.game;
			awaitingComputerMove = false;
			renderState(state.game);
			await renderScoreboard();
		} catch (error) {
			awaitingComputerMove = false;
			state = await store.loadState();
			renderState(state.game);
			setStatus(error.message);
		}
	});

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const initials = input.value.trim().toUpperCase();
		try {
			await store.submitScore(initials);
			state = await store.loadState();
			renderState(state.game);
			await renderScoreboard();
			input.value = '';
		} catch (error) {
			setStatus(error.message);
		}
	});

	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter') {
			return;
		}

		event.preventDefault();
		form.requestSubmit();
	});

	if (playAgainButton) {
		playAgainButton.addEventListener('click', async () => {
			try {
				await submitWinAction('play-again');
			} catch (error) {
				setStatus(error.message);
			}
		});
	}

	if (quitButton) {
		quitButton.addEventListener('click', async () => {
			try {
				await submitWinAction('quit');
			} catch (error) {
				setStatus(error.message);
			}
		});
	}

	document.addEventListener('keydown', async (event) => {
		if (isTypingTarget(event.target)) {
			return;
		}

		if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveSelectionBy(1);
			return;
		}

		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveSelectionBy(-1);
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveSelectionBy(3);
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveSelectionBy(-3);
			return;
		}

		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			const selectedButton = boardElement.querySelector(`button.game-cell[data-index="${selectedIndex}"]`);
			if (selectedButton instanceof HTMLButtonElement && !selectedButton.disabled) {
				selectedButton.click();
			}
		}
	});

	renderState(state.game);
	await renderScoreboard();
});
