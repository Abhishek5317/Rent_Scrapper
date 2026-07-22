const express = require("express");
const cors = require("cors");
const gridRoutes = require("./routes/grids");
const extractionRoutes = require("./routes/extraction");
const propertiesRoutes = require("./routes/properties");

const app = express();

app.use(cors()); // frontend runs on a different origin during dev — needs this
app.use(express.json());

app.use("/api", gridRoutes);
app.use("/api", extractionRoutes);
app.use("/api", propertiesRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Catch-all 404 in the same JSON error shape as every other route,
// so the frontend never has to special-case "route doesn't exist"
// differently from "resource doesn't exist".
app.use((req, res) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

module.exports = app;