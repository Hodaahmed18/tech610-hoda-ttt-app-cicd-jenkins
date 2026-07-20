const DEFAULT_SEEDED_SCOREBOARD = [
	{ initials: 'AAA', score: 100 },
	{ initials: 'BBB', score: 200 },
	{ initials: 'CCC', score: 300 },
	{ initials: 'DDD', score: 400 },
	{ initials: 'EEE', score: 500 },
	{ initials: 'FFF', score: 600 },
	{ initials: 'GGG', score: 700 },
	{ initials: 'HHH', score: 800 },
	{ initials: 'III', score: 900 },
	{ initials: 'JJJ', score: 1000 }
];

function getSeededScoreboard() {
	return DEFAULT_SEEDED_SCOREBOARD.map((entry) => ({ ...entry }));
}

module.exports = {
	getSeededScoreboard
};
