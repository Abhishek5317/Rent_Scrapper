const { Pool } = require("pg");

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        // Discrete fields avoid URL-encoding problems entirely -- a
        // password containing @, :, /, %, #, etc. would otherwise need
        // careful percent-encoding to survive being embedded in a
        // connection-string URL. This sidesteps that whole class of bugs.
        host: process.env.PGHOST || "localhost",
        port: parseInt(process.env.PGPORT || "5432", 10),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "postgres",
        database: process.env.PGDATABASE || "skymark",
      }
);

module.exports = pool;