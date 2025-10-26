import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { tasksRouter } from "./endpoints/tasks/router";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { DummyEndpoint } from "./endpoints/dummyEndpoint";
import morningReport from "./endpoints/morningReport"; // <-- NY: routeren din

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return c.json(
      { success: false, errors: err.buildResponse() },
      err.status as ContentfulStatusCode,
    );
  }
  console.error("Global error handler caught:", err);
  return c.json(
    { success: false, errors: [{ code: 7000, message: "Internal Server Error" }] },
    500,
  );
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
  docs_url: "/",
  schema: {
    info: {
      title: "My Awesome API",
      version: "2.0.0",
      description: "This is the documentation for my awesome API.",
    },
  },
});

// Register routers/endpoints under the same app (IKKE lag en ny app under her)
openapi.route("/tasks", tasksRouter);
openapi.post("/dummy/:slug", DummyEndpoint);

// <-- VIKTIG: Monter morningReport-routeren (eksponerer /morning-report)
openapi.route("/", morningReport);

// ÉN eneste export default
export default app;
