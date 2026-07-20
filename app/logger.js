const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pino = require('pino');

function resolveDestination(env) {
	const destinationType = String(env.LOG_DESTINATION || 'stdout').trim().toLowerCase();

	if (destinationType === 'file') {
		const logFilePath = String(env.LOG_FILE_PATH || './logs/app.log').trim();
		const absoluteLogFilePath = path.isAbsolute(logFilePath)
			? logFilePath
			: path.resolve(process.cwd(), logFilePath);

		fs.mkdirSync(path.dirname(absoluteLogFilePath), { recursive: true });
		return pino.destination({ dest: absoluteLogFilePath, sync: true });
	}

	return pino.destination(1);
}

function createAppLogger({ env = process.env } = {}) {
	const level = String(env.LOG_LEVEL || 'info').trim().toLowerCase();
	const destination = resolveDestination(env);

	return pino({
		level,
		base: {
			component: 'sparta-app-v2',
			service: 'web',
			environment: String(env.NODE_ENV || 'development'),
			node: String(env.HOSTNAME || env.COMPUTERNAME || os.hostname())
		},
		messageKey: 'message',
		formatters: {
			level(label) {
				return { level: label };
			}
		},
		timestamp: pino.stdTimeFunctions.epochTime
	}, destination);
}

module.exports = {
	createAppLogger
};
