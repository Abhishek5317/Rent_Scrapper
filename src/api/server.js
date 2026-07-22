const app = require("./app");

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`RentIQ API listening on http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/api/grids?city=Noida`);
});