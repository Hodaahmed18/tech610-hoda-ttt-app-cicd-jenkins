const { getSeededScoreboard } = require('./seedData');

const seeded = getSeededScoreboard();
const seedBaseUrl = process.env.SEED_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const mongoUri = process.env.MONGODB_URI;

async function getModeLabel() {
	const response = await fetch(`${seedBaseUrl}/`, {
		headers: {
			Accept: 'text/html'
		}
	});

	if (!response.ok) {
		return null;
	}

	const html = await response.text();
	const modeMatch = html.match(/Mode:\s*([^<]+)/i);
	if (!modeMatch) {
		return null;
	}

	return modeMatch[1].trim();
}

async function seedMongoScoreboardDirectly(uri, entries) {
	let MongoClient;
	try {
		({ MongoClient } = require('mongodb'));
	} catch {
		throw new Error('MongoDB driver is not installed. Run npm install in app folder.');
	}

	const client = new MongoClient(uri);
	const now = new Date();

	try {
		await client.connect();
		const collection = client.db().collection('scoreboard_entries');
		await collection.deleteMany({});
		if (entries.length > 0) {
			await collection.insertMany(
				entries.map((entry, index) => ({
					initials: entry.initials,
					score: entry.score,
					createdAt: new Date(now.getTime() + index),
					updatedAt: now
				})),
				{ ordered: true }
			);
		}
	} finally {
		await client.close();
	}
}

async function runSeed() {
	try {
		const modeLabel = await getModeLabel();
		if (modeLabel === 'Client-local stateful') {
			console.log('Error: Cannot seed scoreboard because mode is "Client-local stateful" so scoreboard is stored in user\'s browser localStorage.');
			return;
		}

		const response = await fetch(`${seedBaseUrl}/api/seed`, {
			method: 'POST'
		});

		if (!response.ok) {
			throw new Error(`Seed request failed with status ${response.status}`);
		}

		const data = await response.json();
		console.log(`Seeded active app state via /api/seed (${data.records} records).`);
		return;
	} catch (error) {
		if (mongoUri) {
			try {
				await seedMongoScoreboardDirectly(mongoUri, seeded);
				console.log(`Seeded MongoDB scoreboard_entries directly via MONGODB_URI (${seeded.length} records).`);
				return;
			} catch (mongoError) {
				console.log(`Mongo direct seed failed: ${mongoError.message}`);
			}
		}

		console.log('No running app server detected for /api/seed.');
		console.log('Seed data ready.');
		console.log(JSON.stringify(seeded, null, 2));
		console.log('Start the app and re-run this script to apply defaults to active state, or set MONGODB_URI to seed Mongo directly.');
	}
}

runSeed();
