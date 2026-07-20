const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readFileSync, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');

const execFileAsync = promisify(execFile);

function createMemoryLogger() {
	const entries = [];

	const push = (level, payload) => {
		entries.push({ level, ...payload });
	};

	return {
		entries,
		debug: (payload) => push('debug', payload),
		info: (payload) => push('info', payload),
		warn: (payload) => push('warn', payload),
		error: (payload) => push('error', payload),
		fatal: (payload) => push('fatal', payload)
	};
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.listen(0, () => resolve(server.address().port));
		server.on('error', reject);
	});
}

function readPackageMetadata() {
	const packageJsonPath = path.join(__dirname, '..', 'package.json');
	return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

async function withEnv(overrides, run) {
	const originalValues = {};

	for (const [name, value] of Object.entries(overrides)) {
		originalValues[name] = process.env[name];
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = String(value);
		}
	}

	try {
		await run();
	} finally {
		for (const [name, originalValue] of Object.entries(originalValues)) {
			if (typeof originalValue === 'string') {
				process.env[name] = originalValue;
			} else {
				delete process.env[name];
			}
		}
	}
}

function resetModeEnv() {
	delete process.env.STATEFUL_MODE;
	delete process.env.MONGODB_URI;
}

function createMongoTestUri(baseUri = 'mongodb://localhost:27017/tictactoe') {
	try {
		const uri = new URL(baseUri);
		const dbName = uri.pathname && uri.pathname !== '/' ? uri.pathname.slice(1) : 'tictactoe';
		const isolatedDbName = dbName.endsWith('_test') ? dbName : `${dbName}_test`;
		uri.pathname = `/${isolatedDbName}`;
		return uri.toString();
	} catch {
		return 'mongodb://localhost:27017/tictactoe_test';
	}
}

function isMongoIntegrationEnabled() {
	const value = String(process.env.RUN_MONGO_INTEGRATION || '').trim().toLowerCase();
	return value === 'true';
}

function createMongoIntegrationUri() {
	const configuredUri = String(process.env.MONGODB_INTEGRATION_URI || '').trim();
	const baseUri = configuredUri || 'mongodb://localhost:27017/tictactoe';
	return createMongoTestUri(baseUri);
}

const MONGO_TEST_URI = createMongoTestUri();
const MONGO_INTEGRATION_ENABLED = isMongoIntegrationEnabled();
const MONGO_INTEGRATION_URI = createMongoIntegrationUri();

function mongoIntegrationTest(name, run) {
	test(name, { skip: !MONGO_INTEGRATION_ENABLED }, run);
}

test.beforeEach(() => {
	resetModeEnv();
});

test.afterEach(() => {
	resetModeEnv();
});

test('withEnv applies overrides and restores original env values', async () => {
	const originalStatefulMode = process.env.STATEFUL_MODE;
	const originalMongoUri = process.env.MONGODB_URI;
	process.env.STATEFUL_MODE = 'server';
	process.env.MONGODB_URI = 'mongodb://example:27017/test';

	try {
		await withEnv({ STATEFUL_MODE: undefined, MONGODB_URI: undefined }, async () => {
			assert.equal(process.env.STATEFUL_MODE, undefined);
			assert.equal(process.env.MONGODB_URI, undefined);
		});

		assert.equal(process.env.STATEFUL_MODE, 'server');
		assert.equal(process.env.MONGODB_URI, 'mongodb://example:27017/test');
	} finally {
		if (typeof originalStatefulMode === 'string') {
			process.env.STATEFUL_MODE = originalStatefulMode;
		} else {
			delete process.env.STATEFUL_MODE;
		}

		if (typeof originalMongoUri === 'string') {
			process.env.MONGODB_URI = originalMongoUri;
		} else {
			delete process.env.MONGODB_URI;
		}
	}
});

test('mongo test URI always targets an isolated *_test database', () => {
	assert.match(MONGO_TEST_URI, /\/[^/?#]+_test(?:[/?#]|$)/);
});

test('mongo test URI should not inherit ambient deployment MONGODB_URI host', () => {
	const originalMongoUri = process.env.MONGODB_URI;
	process.env.MONGODB_URI = 'mongodb://172.31.19.159:27017/tictactoe';

	try {
		const derived = createMongoTestUri();
		assert.match(derived, /localhost:27017/);
		assert.match(derived, /tictactoe_test/);
	} finally {
		if (typeof originalMongoUri === 'string') {
			process.env.MONGODB_URI = originalMongoUri;
		} else {
			delete process.env.MONGODB_URI;
		}
	}
});

test('mongo integration URI prefers MONGODB_INTEGRATION_URI over MONGODB_URI', () => {
	const originalMongoUri = process.env.MONGODB_URI;
	const originalMongoIntegrationUri = process.env.MONGODB_INTEGRATION_URI;
	process.env.MONGODB_URI = 'mongodb://172.31.19.159:27017/tictactoe';
	process.env.MONGODB_INTEGRATION_URI = 'mongodb://127.0.0.1:27017/training_suite';

	try {
		const derived = createMongoIntegrationUri();
		assert.match(derived, /127\.0\.0\.1:27017/);
		assert.match(derived, /training_suite_test/);
	} finally {
		if (typeof originalMongoUri === 'string') {
			process.env.MONGODB_URI = originalMongoUri;
		} else {
			delete process.env.MONGODB_URI;
		}

		if (typeof originalMongoIntegrationUri === 'string') {
			process.env.MONGODB_INTEGRATION_URI = originalMongoIntegrationUri;
		} else {
			delete process.env.MONGODB_INTEGRATION_URI;
		}
	}
});

test('mongo integration test flag defaults to disabled', () => {
	const originalFlag = process.env.RUN_MONGO_INTEGRATION;
	delete process.env.RUN_MONGO_INTEGRATION;

	try {
		assert.equal(isMongoIntegrationEnabled(), false);
	} finally {
		if (typeof originalFlag === 'string') {
			process.env.RUN_MONGO_INTEGRATION = originalFlag;
		}
	}
});

test('package metadata advertises official app version 1.2.0', () => {
	const packageJson = readPackageMetadata();

	assert.equal(packageJson.name, 'sparta-app-v2');
	assert.equal(packageJson.version, '1.2.0');
});

test('request lifecycle logs include REQ_100 and REQ_200 with correlation id', async () => {
	await withEnv({ STATEFUL_MODE: undefined, MONGODB_URI: undefined }, async () => {
		const logger = createMemoryLogger();
		const server = createServer({ port: 3000, logger });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/state`);

			assert.equal(response.status, 200);

			const started = logger.entries.find((entry) => entry.code === 'REQ_100');
			const completed = logger.entries.find((entry) => entry.code === 'REQ_200');

			assert.ok(started, 'expected REQ_100 log');
			assert.ok(completed, 'expected REQ_200 log');
			assert.equal(started.route, '/api/state');
			assert.equal(completed.route, '/api/state');
			assert.equal(completed.statusCode, 200);
			assert.equal(typeof completed.durationMs, 'number');
			assert.ok(completed.durationMs >= 0);
			assert.equal(started.mode, 'Client-local stateful');
			assert.equal(completed.mode, 'Client-local stateful');
			assert.equal(response.headers.get('x-correlation-id'), completed.correlationId);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('invalid JSON payload emits REQ_400 monitor log with reason', async () => {
	const logger = createMemoryLogger();
	const server = createServer({ port: 3000, logger });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"game": '
		});

		assert.equal(response.status, 400);

		const invalidJsonLog = logger.entries.find((entry) => {
			return entry.code === 'REQ_400' && entry.reason === 'invalid_json_payload';
		});

		assert.ok(invalidJsonLog, 'expected REQ_400 invalid_json_payload log');
		assert.equal(invalidJsonLog.level, 'warn');
		assert.equal(invalidJsonLog.route, '/api/state');
		assert.equal(invalidJsonLog.method, 'POST');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /metrics exposes Prometheus metrics payload', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/metrics`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type') || '', /text\/plain/i);
		assert.match(body, /http_requests_total/);
		assert.match(body, /http_request_duration_ms/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('request metrics include labels for route method status and mode', async () => {
	await withEnv({ STATEFUL_MODE: undefined, MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			await fetch(`http://127.0.0.1:${port}/api/state`);

			const response = await fetch(`http://127.0.0.1:${port}/metrics`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /http_requests_total\{[^}]*route="\/api\/state"[^}]*method="GET"[^}]*status="200"[^}]*mode="Client-local stateful"[^}]*\}/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('validation failure metric tracks endpoint reason and mode labels', async () => {
	await withEnv({ STATEFUL_MODE: 'server', MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{"game": '
			});

			assert.equal(response.status, 400);

			const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
			const body = await metricsResponse.text();

			assert.equal(metricsResponse.status, 200);
			assert.match(
				body,
				/api_payload_validation_failures_total\{[^}]*endpoint="\/api\/state"[^}]*reason="invalid_json_payload"[^}]*mode="Server-side stateful"[^}]*\}\s+1/
			);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('logger writes JSON entries to file when LOG_DESTINATION=file', async () => {
	const tempDir = mkdtempSync(path.join(os.tmpdir(), 'sparta-logs-'));
	const logFilePath = path.join(tempDir, 'app.log');

	process.env.LOG_DESTINATION = 'file';
	process.env.LOG_FILE_PATH = logFilePath;
	process.env.LOG_LEVEL = 'info';

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`);
		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		delete process.env.LOG_DESTINATION;
		delete process.env.LOG_FILE_PATH;
		delete process.env.LOG_LEVEL;
	}

	const logs = readFileSync(logFilePath, 'utf8');
	assert.match(logs, /"code":"REQ_100"/);
	assert.match(logs, /"code":"REQ_200"/);
	assert.match(logs, /"route":"\/api\/state"/);
});

test('GET / returns main game page', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Tic Tac Toe/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('unknown route returns 404', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
		const body = await response.text();

		assert.equal(response.status, 404);
		assert.equal(body, 'Not Found');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('feature toggle keeps game and scoreboard stateful without MongoDB', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const updatedState = {
			game: { board: ['X', '', '', '', 'O', '', '', '', ''], currentPlayer: 'X' },
			scoreboard: [{ initials: 'ABC', score: 300 }]
		};

		const saveResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(updatedState)
		});

		assert.equal(saveResponse.status, 200);

		const refreshResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const persisted = await refreshResponse.json();

		assert.equal(refreshResponse.status, 200);
		assert.deepEqual(persisted.game.board, updatedState.game.board);
		assert.equal(persisted.game.currentPlayer, updatedState.game.currentPlayer);
		assert.deepEqual(persisted.scoreboard, updatedState.scoreboard);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('without feature toggle, server does not persist game and scoreboard state without MongoDB', async () => {
	delete process.env.STATEFUL_MODE;
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const updatedState = {
			game: { board: ['X', '', '', '', 'O', '', '', '', ''], currentPlayer: 'X' },
			scoreboard: [{ initials: 'ABC', score: 300 }]
		};

		const saveResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(updatedState)
		});

		assert.equal(saveResponse.status, 200);

		const refreshResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const stateAfterRefresh = await refreshResponse.json();

		assert.equal(refreshResponse.status, 200);
		assert.deepEqual(stateAfterRefresh.game.board, ['', '', '', '', '', '', '', '', '']);
		assert.equal(stateAfterRefresh.game.currentPlayer, 'X');
		assert.deepEqual(stateAfterRefresh.scoreboard, []);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('without feature toggle, refreshing frontpage does not mutate server state', async () => {
	delete process.env.STATEFUL_MODE;
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: { board: ['X', '', '', '', 'O', '', '', '', ''], currentPlayer: 'X' },
				scoreboard: [{ initials: 'ABC', score: 300 }]
			})
		});

		await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();

		assert.equal(stateResponse.status, 200);
		assert.deepEqual(state.game.board, ['', '', '', '', '', '', '', '', '']);
		assert.deepEqual(state.scoreboard, []);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 for malformed JSON payload', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"game": '
		});

		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid JSON payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('PUT /api/state returns 404 for unsupported method', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: [] })
		});

		const body = await response.text();

		assert.equal(response.status, 404);
		assert.equal(body, 'Not Found');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /api/state returns default schema when feature toggle is off', async () => {
	delete process.env.STATEFUL_MODE;
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await response.json();

		assert.equal(response.status, 200);
		assert.ok(state.game);
		assert.ok(Array.isArray(state.game.board));
		assert.equal(state.game.board.length, 9);
		assert.equal(state.game.currentPlayer, 'X');
		assert.ok(Array.isArray(state.scoreboard));
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when game board length is not 9', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: { board: ['X', 'O'], currentPlayer: 'X' },
				scoreboard: []
			})
		});

		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when scoreboard is not an array', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				scoreboard: { initials: 'ABC', score: 300 }
			})
		});

		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when scoreboard entry shape is invalid', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				scoreboard: [{ initials: 'AB', score: '300' }]
			})
		});

		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / shows client-local stateful mode indicator when no database is connected', async () => {
	delete process.env.MONGODB_URI;
	delete process.env.STATEFUL_MODE;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Mode: Client-local stateful/i);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

mongoIntegrationTest('[integration] GET / shows Mongo mode indicator when database is configured', async () => {
	process.env.MONGODB_URI = MONGO_INTEGRATION_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Mode: Persistent with Mongo DB/i);
	} finally {
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / falls back to client-local mode indicator when Mongo connection is refused and STATEFUL_MODE is not server', async () => {
	delete process.env.STATEFUL_MODE;
	process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tictactoe_test';

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Mode: Client-local stateful/i);
		assert.doesNotMatch(body, /Mode: Server-side stateful/i);
		assert.doesNotMatch(body, /Mode: Persistent with Mongo DB/i);
	} finally {
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / falls back to server-side mode indicator when Mongo connection is refused and STATEFUL_MODE=server', async () => {
	process.env.STATEFUL_MODE = 'server';
	process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tictactoe_test';

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Mode: Server-side stateful/i);
		assert.doesNotMatch(body, /Mode: Persistent with Mongo DB/i);
	} finally {
		delete process.env.STATEFUL_MODE;
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('Mongo connection refusal emits structured fallback logs', async () => {
	delete process.env.STATEFUL_MODE;
	process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tictactoe_test';

	const logger = createMemoryLogger();
	const server = createServer({ port: 3000, logger });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`);
		assert.equal(response.status, 200);

		const mongoConnectFailure = logger.entries.find((entry) => entry.code === 'MDB_002');
		const mongoFallbackActivation = logger.entries.find((entry) => entry.code === 'MDB_004');

		assert.ok(mongoConnectFailure, 'expected MDB_002 log entry');
		assert.ok(mongoFallbackActivation, 'expected MDB_004 log entry');
		assert.equal(mongoConnectFailure.level, 'error');
		assert.equal(mongoFallbackActivation.level, 'warn');
		assert.equal(mongoConnectFailure.mode, 'Client-local stateful');
		assert.equal(mongoFallbackActivation.mode, 'Client-local stateful');
		assert.equal(mongoConnectFailure.fallbackStorage, 'client-local');
		assert.equal(mongoFallbackActivation.fallbackStorage, 'client-local');
		assert.equal(mongoConnectFailure.message, 'Mongo connection failed; using client-local fallback');
		assert.match(String(mongoConnectFailure.error || ''), /ECONNREFUSED|connect/i);
	} finally {
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('Mongo connection refusal emits server-side fallback logs when STATEFUL_MODE=server', async () => {
	process.env.STATEFUL_MODE = 'server';
	process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tictactoe_test';

	const logger = createMemoryLogger();
	const server = createServer({ port: 3000, logger });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`);
		assert.equal(response.status, 200);

		const mongoConnectFailure = logger.entries.find((entry) => entry.code === 'MDB_002');
		const mongoFallbackActivation = logger.entries.find((entry) => entry.code === 'MDB_004');

		assert.ok(mongoConnectFailure, 'expected MDB_002 log entry');
		assert.ok(mongoFallbackActivation, 'expected MDB_004 log entry');
		assert.equal(mongoConnectFailure.mode, 'Server-side stateful');
		assert.equal(mongoFallbackActivation.mode, 'Server-side stateful');
		assert.equal(mongoConnectFailure.fallbackStorage, 'server-memory');
		assert.equal(mongoFallbackActivation.fallbackStorage, 'server-memory');
		assert.equal(mongoConnectFailure.message, 'Mongo connection failed; using server in-memory fallback');
	} finally {
		delete process.env.STATEFUL_MODE;
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / shows stateful mode indicator when STATEFUL_MODE=server', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Mode: Server-side stateful/i);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('stateful mode isolates game by session while keeping scoreboard global', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-session-id': 'session-a'
			},
			body: JSON.stringify({
				game: { board: ['X', '', '', '', '', '', '', '', ''], currentPlayer: 'O' },
				scoreboard: [{ initials: 'AAA', score: 100 }]
			})
		});

		const sessionAStateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
			headers: { 'x-session-id': 'session-a' }
		});
		const sessionAState = await sessionAStateResponse.json();
		assert.equal(sessionAState.game.board[0], 'X');
		assert.equal(sessionAState.scoreboard.length, 1);

		const sessionBStateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
			headers: { 'x-session-id': 'session-b' }
		});
		const sessionBState = await sessionBStateResponse.json();

		assert.deepEqual(sessionBState.game.board, ['', '', '', '', '', '', '', '', '']);
		assert.equal(sessionBState.game.currentPlayer, 'X');
		assert.equal(sessionBState.scoreboard.length, 1);
		assert.equal(sessionBState.scoreboard[0].initials, 'AAA');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /scoreboard shows top 10 scores with initials', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const scores = Array.from({ length: 12 }, (_, index) => ({
			initials: `A${String(index).padStart(2, '0')}`.slice(0, 3),
			score: index * 100
		}));

		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: scores })
		});

		const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Server Scoreboard/i);
		assert.match(body, /A11\s{2}1100/);
		assert.match(body, /A09\s{2}\s900/);
		assert.doesNotMatch(body, /A11:\s*110/);
		assert.match(body, /A11/);
		assert.doesNotMatch(body, /A00/);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / uses Local Scoreboard title in client-local mode', async () => {
	delete process.env.STATEFUL_MODE;
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<h2>Local Scoreboard<\/h2>/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / uses Server Scoreboard title in server-side stateful mode', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<h2>Server Scoreboard<\/h2>/);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

mongoIntegrationTest('[integration] GET / uses Global Scoreboard title in Mongo mode', async () => {
	delete process.env.STATEFUL_MODE;
	process.env.MONGODB_URI = MONGO_INTEGRATION_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<h2>Global Scoreboard<\/h2>/);
	} finally {
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/seed resets scoreboard to default 10 seeded records', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				scoreboard: [{ initials: 'ZZZ', score: 9999 }]
			})
		});

		const seedResponse = await fetch(`http://127.0.0.1:${port}/api/seed`, {
			method: 'POST'
		});
		assert.equal(seedResponse.status, 200);

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();

		assert.equal(state.scoreboard.length, 10);
		assert.deepEqual(state.scoreboard.map((entry) => entry.initials), [
			'AAA',
			'BBB',
			'CCC',
			'DDD',
			'EEE',
			'FFF',
			'GGG',
			'HHH',
			'III',
			'JJJ'
		]);
		assert.deepEqual(state.scoreboard.map((entry) => entry.score), [
			100,
			200,
			300,
			400,
			500,
			600,
			700,
			800,
			900,
			1000
		]);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/submit-score saves score in server-side stateful fallback mode when Mongo connection is refused', async () => {
	process.env.STATEFUL_MODE = 'server';
	process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/tictactoe_test';

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		// Set up game state with awaitingInitials so we can submit
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', 'X', 'O', 'O', '', '', '', ''],
					currentPlayer: 'O',
					roundNumber: 1,
					score: 150,
					awaitingInitials: true,
					gameOver: true,
					lastRoundResult: 'win'
				}
			})
		});

		// Submit score
		const submitResponse = await fetch(`http://127.0.0.1:${port}/api/game/submit-score`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials: 'TST' })
		});
		assert.equal(submitResponse.status, 200);

		// Verify score was saved to in-memory state
		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();
		assert.ok(state.scoreboard.some((entry) => entry.initials === 'TST' && entry.score === 150), 'expected score to be saved in server-side stateful fallback');
	} finally {
		delete process.env.STATEFUL_MODE;
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move plays against computer opponent', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.board[0], 'X');
		assert.ok(body.game.board.includes('O'));
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move uses easy difficulty on first round', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.computerDifficulty, 'easy');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move uses medium difficulty on rounds two and three', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['', '', '', '', '', '', '', '', ''],
					currentPlayer: 'X',
					roundNumber: 2
				}
			})
		});

		const secondRoundResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const secondRoundBody = await secondRoundResponse.json();
		assert.equal(secondRoundResponse.status, 200);
		assert.equal(secondRoundBody.game.computerDifficulty, 'medium');

		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['', '', '', '', '', '', '', '', ''],
					currentPlayer: 'X',
					roundNumber: 3
				}
			})
		});

		const thirdRoundResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const thirdRoundBody = await thirdRoundResponse.json();
		assert.equal(thirdRoundResponse.status, 200);
		assert.equal(thirdRoundBody.game.computerDifficulty, 'medium');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move uses hard difficulty from round four onward', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['', '', '', '', '', '', '', '', ''],
					currentPlayer: 'X',
					roundNumber: 4
				}
			})
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.computerDifficulty, 'hard');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('winning a round keeps the winning board, increments score, and flags game over', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', '', 'O', 'O', '', '', '', ''],
					currentPlayer: 'X',
					score: 0,
					streak: 0,
					awaitingInitials: false
				}
			})
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 2 })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.roundResult, 'win');
		assert.equal(body.game.score, 100);
		assert.equal(body.game.drawCarryPoints, 0);
		assert.equal(body.game.streak, 1);
		assert.equal(body.game.gameOver, true);
		assert.equal(body.game.awaitingInitials, false);
		assert.deepEqual(body.game.board, ['X', 'X', 'X', 'O', 'O', '', '', '', '']);
		assert.deepEqual(body.game.winningLine, [0, 1, 2]);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/next-round with play-again resets board and keeps run state after a win', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', '', 'O', 'O', '', '', '', ''],
					currentPlayer: 'X',
					score: 100,
					streak: 1,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 2 })
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'play-again' })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.gameOver, false);
		assert.equal(body.game.score, 200);
		assert.equal(body.game.streak, 2);
		assert.deepEqual(body.game.board, ['', '', '', '', '', '', '', '', '']);
		assert.deepEqual(body.game.winningLine, []);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/next-round with quit asks for initials and keeps score after a win', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', '', 'O', 'O', '', '', '', ''],
					currentPlayer: 'X',
					score: 200,
					streak: 2,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 2 })
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'quit' })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.gameOver, true);
		assert.equal(body.game.awaitingInitials, true);
		assert.equal(body.game.lastRoundResult, 'quit');
		assert.equal(body.game.score, 300);
		assert.equal(body.game.streak, 3);
		assert.deepEqual(body.game.board, ['X', 'X', 'X', 'O', 'O', '', '', '', '']);
		assert.deepEqual(body.game.winningLine, []);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('quit after win allows submitting initials and saves score', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', '', 'O', 'O', '', '', '', ''],
					currentPlayer: 'X',
					score: 200,
					streak: 2,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 2 })
		});

		await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'quit' })
		});

		const submitResponse = await fetch(`http://127.0.0.1:${port}/api/game/submit-score`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials: 'QIT' })
		});
		assert.equal(submitResponse.status, 200);

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();
		assert.ok(state.scoreboard.some((entry) => entry.initials === 'QIT' && entry.score === 300));
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

mongoIntegrationTest('[integration] losing a round ends game and allows submitting initials to save final score', async () => {
	process.env.MONGODB_URI = MONGO_INTEGRATION_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['O', 'O', '', 'X', 'X', '', '', '', ''],
					currentPlayer: 'X',
					roundNumber: 2,
					score: 200,
					streak: 2,
					awaitingInitials: false
				}
			})
		});

		const loseResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 6 })
		});
		const loseBody = await loseResponse.json();

		assert.equal(loseResponse.status, 200);
		assert.equal(loseBody.roundResult, 'loss');
		assert.equal(loseBody.game.awaitingInitials, true);

		const submitResponse = await fetch(`http://127.0.0.1:${port}/api/game/submit-score`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials: 'XYZ' })
		});
		assert.equal(submitResponse.status, 200);

		const scoreboardResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await scoreboardResponse.json();

		assert.ok(state.scoreboard.some((entry) => entry.initials === 'XYZ' && entry.score === 200));
	} finally {
		delete process.env.MONGODB_URI;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / includes Tic Tac Toe game title', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /Tic Tac Toe/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

mongoIntegrationTest('[integration] GET /scoreboard uses MongoDB-backed scores when database is connected', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: [{ initials: 'RED', score: 111 }] })
		});

		process.env.MONGODB_URI = MONGO_INTEGRATION_URI;

		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: [{ initials: 'DB1', score: 999 }] })
		});

		const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /DB1/);
		assert.doesNotMatch(body, /RED/);
	} finally {
		delete process.env.MONGODB_URI;
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

mongoIntegrationTest('[integration] Mongo store shutdown does not log post-close session warnings', async () => {
	process.env.MONGODB_URI = MONGO_INTEGRATION_URI;
	delete process.env.STATEFUL_MODE;

	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...messages) => {
		warnings.push(messages.join(' '));
	};

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: [{ initials: 'DB2', score: 777 }] })
		});

		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await new Promise((resolve) => setTimeout(resolve, 50));
		delete process.env.MONGODB_URI;
		console.warn = originalWarn;
	}

	assert.equal(warnings.some((message) => message.includes('Cannot use a session that has ended')), false);
});

test('GET /scoreboard uses stateful-toggle-backed scores when database is not connected', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scoreboard: [{ initials: 'RS1', score: 500 }] })
		});

		const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /RS1/);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('draw round returns draw result and keeps board for draw decision without changing score', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 300,
					streak: 3,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.roundResult, 'draw');
		assert.equal(body.game.score, 300);
		assert.equal(body.game.drawCarryPoints, 100);
		assert.equal(body.game.streak, 0);
		assert.equal(body.game.gameOver, true);
		assert.equal(body.game.awaitingInitials, false);
		assert.deepEqual(body.game.board, ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('draw does not set awaitingInitials and does not add scoreboard entry immediately', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 100,
					streak: 1,
					awaitingInitials: false,
					gameOver: false
				},
				scoreboard: [{ initials: 'AAA', score: 1000 }]
			})
		});

		const moveResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});
		const moveBody = await moveResponse.json();

		assert.equal(moveBody.roundResult, 'draw');
		assert.equal(moveBody.game.awaitingInitials, false);
		assert.equal(moveBody.game.gameOver, true);
		assert.equal(moveBody.game.drawCarryPoints, 100);

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();
		assert.equal(state.scoreboard.length, 1);
		assert.equal(state.scoreboard[0].initials, 'AAA');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/next-round with play-again resets board after a draw without adding points', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 300,
					streak: 3,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'play-again' })
		});
		const body = await response.json();

		assert.equal(response.status, 200);
		assert.equal(body.game.gameOver, false);
		assert.equal(body.game.score, 300);
		assert.equal(body.game.drawCarryPoints, 100);
		assert.deepEqual(body.game.board, ['', '', '', '', '', '', '', '', '']);
		assert.equal(body.game.lastRoundResult, null);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('consecutive draws add carry-over points and next win awards all stored points', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 0,
					drawCarryPoints: 0,
					streak: 0,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		const firstDrawResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});
		const firstDrawBody = await firstDrawResponse.json();
		assert.equal(firstDrawBody.roundResult, 'draw');
		assert.equal(firstDrawBody.game.drawCarryPoints, 100);

		await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'play-again' })
		});

		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		const secondDrawResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});
		const secondDrawBody = await secondDrawResponse.json();
		assert.equal(secondDrawBody.roundResult, 'draw');
		assert.equal(secondDrawBody.game.drawCarryPoints, 200);

		await fetch(`http://127.0.0.1:${port}/api/game/next-round`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'play-again' })
		});

		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', '', 'O', 'O', '', '', '', ''],
					currentPlayer: 'X',
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		const winResponse = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 2 })
		});
		const winBody = await winResponse.json();

		assert.equal(winBody.roundResult, 'win');
		assert.equal(winBody.game.score, 300);
		assert.equal(winBody.game.drawCarryPoints, 0);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move returns 400 when it is not the player turn', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', '', '', '', '', '', '', '', ''],
					currentPlayer: 'O',
					score: 0,
					streak: 0,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 0 })
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Not player turn');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/move returns 400 after game is over until initials are submitted', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['O', 'O', 'X', 'X', 'X', 'O', '', '', ''],
					currentPlayer: 'X',
					score: 200,
					streak: 2,
					awaitingInitials: true,
					gameOver: true
				}
			})
		});

		const response = await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 5 })
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Game is over. Submit initials first.');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when board contains invalid token values', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'Q', '', '', '', '', '', ''],
					currentPlayer: 'X'
				}
			})
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when board has impossible token count difference', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'X', 'X', '', '', '', '', '', ''],
					currentPlayer: 'X'
				}
			})
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state accepts board with valid token balance', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'O', '', '', '', '', ''],
					currentPlayer: 'X'
				}
			})
		});

		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/game/submit-score returns draw-specific error after a draw', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 100,
					streak: 1,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});

		const submitResponse = await fetch(`http://127.0.0.1:${port}/api/game/submit-score`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials: 'DRW' })
		});
		const submitBody = await submitResponse.json();

		assert.equal(submitResponse.status, 400);
		assert.equal(submitBody.error, 'Draw rounds cannot be submitted to scoreboard');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('draw submission rejection keeps scoreboard unchanged', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				scoreboard: [{ initials: 'AAA', score: 500 }],
				game: {
					board: ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''],
					currentPlayer: 'X',
					score: 100,
					streak: 1,
					awaitingInitials: false,
					gameOver: false
				}
			})
		});

		await fetch(`http://127.0.0.1:${port}/api/game/move`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index: 8 })
		});

		await fetch(`http://127.0.0.1:${port}/api/game/submit-score`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ initials: 'DRW' })
		});

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();

		assert.equal(state.scoreboard.length, 1);
		assert.equal(state.scoreboard[0].initials, 'AAA');
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when currentPlayer is X but counts require O turn', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', '', '', '', '', '', ''],
					currentPlayer: 'X'
				}
			})
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state returns 400 when currentPlayer is O but counts require X turn', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', '', '', '', '', '', '', ''],
					currentPlayer: 'O'
				}
			})
		});
		const body = await response.json();

		assert.equal(response.status, 400);
		assert.equal(body.error, 'Invalid state payload');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('POST /api/state accepts currentPlayer that matches board token counts', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				game: {
					board: ['X', 'O', 'X', '', '', '', '', '', ''],
					currentPlayer: 'O'
				}
			})
		});

		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / serves playable retro UI shell', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /id="game-board"/);
		assert.match(body, /class="game-cell"/);
		assert.match(body, /id="score-value"/);
		assert.match(body, /id="game-board"[\s\S]*id="score-value"/);
		assert.equal(body.includes('id="streak-value"'), false);
		assert.equal(body.includes('Streak:'), false);
		assert.match(body, /id="status-text"/);
		assert.match(body, /id="initials-form"\s+hidden/);
		assert.match(body, /id="win-actions"\s+hidden/);
		assert.match(body, /id="play-again-btn"/);
		assert.match(body, /id="quit-btn"/);
		assert.match(body, /Continue\?/);
		assert.match(body, /Quit\?/);
		assert.match(body, /href="\/styles.css"/);
		assert.match(body, /src="\/app.js"/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / defaults marker image toggle to off', async () => {
	delete process.env.USE_MARKER_IMAGES;
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		assert.match(body, /<meta name="marker-images-path" content="\/images"\s*\/>/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / defaults marker image path to /images when MARKER_IMAGES_PATH is unset', async () => {
	await withEnv({ MARKER_IMAGES_PATH: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="marker-images-path" content="\/images"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / uses MARKER_IMAGES_PATH for marker images when configured', async () => {
	await withEnv({ MARKER_IMAGES_PATH: 'https://cdn.example.com/assets/markers' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="marker-images-path" content="https:\/\/cdn\.example\.com\/assets\/markers"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / trims trailing slash from MARKER_IMAGES_PATH', async () => {
	await withEnv({ MARKER_IMAGES_PATH: 'https://cdn.example.com/assets/markers/' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="marker-images-path" content="https:\/\/cdn\.example\.com\/assets\/markers"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / falls back to /images when MARKER_IMAGES_PATH is non-http(s)', async () => {
	await withEnv({ MARKER_IMAGES_PATH: 'ftp://cdn.example.com/assets/markers' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="marker-images-path" content="\/images"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('invalid MARKER_IMAGES_PATH logs a config warning and uses /images fallback', async () => {
	await withEnv({ MARKER_IMAGES_PATH: 'ftp://cdn.example.com/assets/markers' }, async () => {
		const logger = createMemoryLogger();
		const server = createServer({ port: 3000, logger });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="marker-images-path" content="\/images"\s*\/>/);

			const warning = logger.entries.find((entry) => entry.code === 'CFG_001');
			assert.ok(warning, 'expected CFG_001 warning for invalid MARKER_IMAGES_PATH');
			assert.equal(warning.level, 'warn');
			assert.equal(warning.reason, 'invalid_marker_images_path');
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / enables marker image toggle when USE_MARKER_IMAGES=true', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'true' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="true"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / enables marker image toggle when USE_MARKER_IMAGES=True', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'True' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="true"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / enables marker image toggle when USE_MARKER_IMAGES=TRUE', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'TRUE' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="true"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / keeps marker image toggle off when USE_MARKER_IMAGES=false', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'false' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / keeps marker image toggle off when USE_MARKER_IMAGES=False', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'False' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / keeps marker image toggle off when USE_MARKER_IMAGES=FALSE', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'FALSE' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / keeps marker image toggle off when USE_MARKER_IMAGES=1', async () => {
	await withEnv({ USE_MARKER_IMAGES: '1' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET / keeps marker image toggle off when USE_MARKER_IMAGES=on', async () => {
	await withEnv({ USE_MARKER_IMAGES: 'on' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<meta name="use-marker-images" content="false"\s*\/>/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET /images/x.png and /images/o.png are served for marker image mode', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const xResponse = await fetch(`http://127.0.0.1:${port}/images/x.png`);
		const oResponse = await fetch(`http://127.0.0.1:${port}/images/o.png`);

		assert.equal(xResponse.status, 200);
		assert.match(xResponse.headers.get('content-type') || '', /image\/png/i);
		assert.equal(oResponse.status, 200);
		assert.match(oResponse.headers.get('content-type') || '', /image\/png/i);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /styles.css and /app.js are served for UI', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const cssResponse = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const cssBody = await cssResponse.text();
		assert.equal(cssResponse.status, 200);
		assert.match(cssBody, /retro|matrix|green/i);

		const jsResponse = await fetch(`http://127.0.0.1:${port}/app.js`);
		const jsBody = await jsResponse.text();
		assert.equal(jsResponse.status, 200);
		assert.match(jsBody, /api\/game\/move/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /scoreboard serves retro styled page shell', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /href="\/styles.css"/);
		assert.match(body, /class="retro-shell"/);
		assert.match(body, /id="scoreboard-list"/);
		assert.match(body, /Back to Game/i);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /scoreboard uses homepage-style scoreboard panel formatting', async () => {
	await withEnv({ STATEFUL_MODE: 'server', MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /<h2>Server Scoreboard<\/h2>/);
			assert.doesNotMatch(body, /<h1 class="retro-title">/);
			assert.doesNotMatch(body, /Top 10 scores in the active mode\./);
			assert.match(body, /<ol id="scoreboard-list">/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET /scoreboard uses dedicated centered scoreboard panel class', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<section class="panel scoreboard-panel">/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css center-aligns scoreboard route panel content', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.scoreboard-panel\s*\{[^}]*text-align:\s*center\s*;/);
		assert.match(body, /\.scoreboard-panel\s+#scoreboard-list\s*\{[^}]*text-align:\s*center\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('app.js uses resilient click targeting for game cells', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /closest\('button\.game-cell'\)/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('app.js includes keyboard controls for board navigation and move selection', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /addEventListener\('keydown'/);
		assert.match(body, /ArrowUp|ArrowDown|ArrowLeft|ArrowRight/);
		assert.match(body, /Enter/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('app.js supports rendering marker images for X and O tokens', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /marker-images-path/);
		assert.match(body, /\/x\.png/);
		assert.match(body, /\/o\.png/);
		assert.match(body, /marker-image/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css includes CRT scanline overlay styling', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /scanline|crt|repeating-linear-gradient/i);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css renders scoreboard list without numbering', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /#scoreboard-list\s*\{[^}]*list-style:\s*none\s*;[^}]*padding-left:\s*0\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css aligns scoreboard initials in a single left-aligned column', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /#scoreboard-list\s*\{[^}]*display:\s*inline-block\s*;[^}]*text-align:\s*left\s*;[^}]*margin:\s*8px\s+auto\s+0\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css center-aligns content in main playing panel', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.game-column\s*>\s*\.panel\s*\{[\s\S]*text-align:\s*center\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css uses wider centered game board in main playing panel', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /#game-board\s*\{[\s\S]*margin:\s*8px\s+auto\s+0\s*;[\s\S]*width:\s*60%\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css keeps game board centered on mobile widths', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /@media\s*\(max-width:\s*800px\)\s*\{[\s\S]*#game-board\s*\{[\s\S]*width:\s*min\(100%,\s*320px\)\s*;[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css uses larger X and O glyphs on desktop board cells', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.game-cell\s*\{[^}]*font-size:\s*3rem\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css makes marker images fill the game cell box', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.marker-image\s*\{[^}]*width:\s*100%\s*;[^}]*height:\s*100%\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / places game title above both panels at top of page', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<body class="retro-shell">\s*<h1 class="retro-title">Tic Tac Toe<\/h1>\s*<div class="layout">/);
		assert.equal(body.includes('<h2>Tic Tac Toe</h2>'), false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / places scoreboard panel below main game panel', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /<section class="panel">[\s\S]*<\/section>\s*<section class="panel">\s*<h2>Local Scoreboard<\/h2>[\s\S]*<\/section>\s*<\/div>/);
		assert.equal(body.includes('<h2>Top Scores</h2>'), false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / renders copyright footer, mode pill, and package version stamp at very bottom outside panels', async () => {
	const packageJson = readPackageMetadata();
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(
			body,
			new RegExp(`</div>\\s*<p class="page-footer">Copyright © 2026 Sparta Global</p>\\s*<p class="mode-pill">Mode:\\s*(Client-local stateful|Server-side stateful|Persistent with Mongo DB)</p>\\s*<p class="version-stamp">v${packageJson.version}(?: [^<]+)?</p>\\s*<script src="/app\\.js"></script>`)
		);
		assert.equal(/<section class="panel">\s*<p class="page-footer">/.test(body), false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET / appends configured footer timestamp after the package version', async () => {
	const packageJson = readPackageMetadata();
		await withEnv({ APP_FOOTER_TIMESTAMP: '15/05/2026 17:20' }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, new RegExp(`<p class="version-stamp">v${packageJson.version} 15/05/2026 17:20</p>`));
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('styles.css centers footer version stamp text', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.version-stamp\s*\{[^}]*text-align:\s*center\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css centers the page title text', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.retro-title\s*\{[^}]*text-align:\s*center\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('styles.css centers mode pill text', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/styles.css`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\.mode-pill\s*\{[^}]*margin:\s*6px\s+auto\s+0\s*;[^}]*text-align:\s*center\s*;/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('GET /api/scoreboard returns an empty array in client-local stateful mode', async () => {
	await withEnv({ STATEFUL_MODE: undefined, MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			await fetch(`http://127.0.0.1:${port}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					scoreboard: [{ initials: 'AAA', score: 500 }],
					game: { board: ['X', '', '', '', 'O', '', '', '', ''], currentPlayer: 'X' }
				})
			});

			const scoreResponse = await fetch(`http://127.0.0.1:${port}/api/scoreboard`);
			const scoreData = await scoreResponse.json();
			assert.equal(scoreResponse.status, 200);
			assert.ok(Array.isArray(scoreData));
			assert.deepEqual(scoreData, []);

			const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
			const state = await stateResponse.json();
			assert.deepEqual(state.game.board, ['', '', '', '', '', '', '', '', '']);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET /scoreboard in client-local mode renders scores from browser localStorage', async () => {
	await withEnv({ STATEFUL_MODE: undefined, MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			const response = await fetch(`http://127.0.0.1:${port}/scoreboard`);
			const body = await response.text();

			assert.equal(response.status, 200);
			assert.match(body, /Local Scoreboard/);
			assert.match(body, /ttt_scoreboard_v1/);
			assert.match(body, /localStorage\.getItem/);
			assert.match(body, /No scores yet/);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('GET /api/scoreboard returns top 10 scores in server-side stateful mode', async () => {
	await withEnv({ STATEFUL_MODE: 'server', MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			await fetch(`http://127.0.0.1:${port}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					scoreboard: [
						{ initials: 'AAA', score: 100 },
						{ initials: 'BBB', score: 300 },
						{ initials: 'CCC', score: 200 }
					]
				})
			});

			const scoreResponse = await fetch(`http://127.0.0.1:${port}/api/scoreboard`);
			const scoreData = await scoreResponse.json();

			assert.equal(scoreResponse.status, 200);
			assert.deepEqual(scoreData, [
				{ initials: 'BBB', score: 300 },
				{ initials: 'CCC', score: 200 },
				{ initials: 'AAA', score: 100 }
			]);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

mongoIntegrationTest('[integration] GET /api/scoreboard returns mongo-backed scores when Mongo mode is active', async () => {
	await withEnv({ STATEFUL_MODE: 'server', MONGODB_URI: undefined }, async () => {
		const server = createServer({ port: 3000 });
		const port = await listen(server);

		try {
			await fetch(`http://127.0.0.1:${port}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scoreboard: [{ initials: 'RED', score: 111 }] })
			});

			process.env.MONGODB_URI = MONGO_INTEGRATION_URI;

			await fetch(`http://127.0.0.1:${port}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scoreboard: [{ initials: 'DB1', score: 999 }] })
			});

			const scoreResponse = await fetch(`http://127.0.0.1:${port}/api/scoreboard`);
			const scoreData = await scoreResponse.json();

			assert.equal(scoreResponse.status, 200);
			assert.equal(scoreData.some((entry) => entry.initials === 'DB1'), true);
			assert.equal(scoreData.some((entry) => entry.initials === 'RED'), false);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('app.js loads scoreboard from /api/scoreboard endpoint', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /\/api\/scoreboard/);
		assert.match(body, /`\$\{entry\.initials\}\s{2}\$\{String\(entry\.score\)\.padStart\(scoreWidth, ' '\)\}`/);
		assert.match(body, /padStart\(/);
		assert.doesNotMatch(body, /`\$\{entry\.initials\}:\s*\$\{entry\.score\}`/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('app.js wires round-end actions through /api/game/next-round endpoint', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /play-again/);
		assert.match(body, /quit/);
		assert.match(body, /Draw! \$\{drawCarryPoints\} points stored up for next win\./);
		assert.match(body, /\/api\/game\/next-round/);
		assert.match(body, /winning-cell/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('app.js shows human X instantly then delays computer move request by 300ms', async () => {
	const server = createServer({ port: 3000 });
	const port = await listen(server);

	try {
		const response = await fetch(`http://127.0.0.1:${port}/app.js`);
		const body = await response.text();

		assert.equal(response.status, 200);
		assert.match(body, /state\.game\.board\[index\]\s*=\s*'X'/);
		assert.match(body, /renderBoard\(state\.game\);/);
		assert.match(body, /setTimeout\(resolve,\s*300\)/);
		assert.match(body, /requestJson\('\/api\/game\/move'/);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('seed.js uses SEED_BASE_URL to seed a running server on a non-default port', async () => {
	process.env.STATEFUL_MODE = 'server';
	delete process.env.MONGODB_URI;

	const server = createServer({ port: 3000 });
	const port = await listen(server);
	const seedScriptPath = path.join(__dirname, '..', 'seeds', 'seed.js');

	try {
		await fetch(`http://127.0.0.1:${port}/api/state`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				scoreboard: [{ initials: 'ZZZ', score: 9999 }]
			})
		});

		const { stdout } = await execFileAsync(process.execPath, [seedScriptPath], {
			cwd: path.join(__dirname, '..'),
			env: {
				...process.env,
				STATEFUL_MODE: 'server',
				SEED_BASE_URL: `http://127.0.0.1:${port}`
			},
			encoding: 'utf8'
		});

		assert.match(stdout, /Seeded active app state via \/api\/seed \(10 records\)\./);

		const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
		const state = await stateResponse.json();

		assert.equal(state.scoreboard.length, 10);
		assert.deepEqual(state.scoreboard.map((entry) => entry.initials), [
			'AAA',
			'BBB',
			'CCC',
			'DDD',
			'EEE',
			'FFF',
			'GGG',
			'HHH',
			'III',
			'JJJ'
		]);
	} finally {
		delete process.env.STATEFUL_MODE;
		await new Promise((resolve) => server.close(resolve));
	}
});
