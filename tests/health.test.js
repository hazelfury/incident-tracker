const request = require("supertest");
const createApp = require("../src/app");

describe("GET /api/health", () => {
  const app = createApp();

  it("returns 200 with an ok status and db connection info", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db.connected).toBe(true);
  });
});

describe("unknown routes", () => {
  const app = createApp();

  it("returns a 404 with a JSON error body", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Route not found/);
  });
});
