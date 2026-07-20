const { createServer } = require('./server');

const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
	const server = createServer({ port: PORT });
	server.listen(PORT, () => {
		console.log(`Server running at http://localhost:${PORT}`);
	});
}
