const { Counter, Histogram, Registry } = require('prom-client');

function createMetrics() {
	const registry = new Registry();

	const httpRequestsTotal = new Counter({
		name: 'http_requests_total',
		help: 'Total number of HTTP requests handled by the server',
		labelNames: ['route', 'method', 'status', 'mode'],
		registers: [registry]
	});

	const httpRequestDurationMs = new Histogram({
		name: 'http_request_duration_ms',
		help: 'Duration of HTTP requests in milliseconds',
		labelNames: ['route', 'method', 'status', 'mode'],
		buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
		registers: [registry]
	});

	const apiPayloadValidationFailuresTotal = new Counter({
		name: 'api_payload_validation_failures_total',
		help: 'Total number of payload validation failures by endpoint and reason',
		labelNames: ['endpoint', 'reason', 'mode'],
		registers: [registry]
	});

	return {
		contentType: registry.contentType,
		observeRequest({ route, method, statusCode, mode, durationMs }) {
			const labels = {
				route,
				method,
				status: String(statusCode),
				mode
			};

			httpRequestsTotal.inc(labels, 1);
			httpRequestDurationMs.observe(labels, durationMs);
		},
		observeValidationFailure({ endpoint, reason, mode }) {
			apiPayloadValidationFailuresTotal.inc({ endpoint, reason, mode }, 1);
		},
		render: async () => registry.metrics()
	};
}

module.exports = {
	createMetrics
};
