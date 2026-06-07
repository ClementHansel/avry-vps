import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from "vitest";
import {
  bootstrap,
  validateEnv,
  isDockerSocketReachable,
  type EnvConfig,
} from "../../src/server.js";
import type { Express } from "express";
import type { Server as HttpServer } from "node:http";
import type { Server as SocketIOServer } from "socket.io";
import request from "supertest";

describe("Server Bootstrap", () => {
  let app: Express;
  let io: SocketIOServer;
  let httpServer: HttpServer;
  let config: EnvConfig;

  beforeEach(() => {
    const result = bootstrap({
      PORT: 3999,
      SUPABASE_JWT_SECRET: "test-secret",
      DOCKER_HOST: "/var/run/docker.sock",
      ENVIRONMENT: "test",
      CORS_ORIGINS: ["*"],
    });
    app = result.app;
    io = result.io;
    httpServer = result.httpServer;
    config = result.config;
  });

  afterEach(() => {
    io.close();
    httpServer.close();
  });

  describe("Environment Variable Validation", () => {
    it("should parse config correctly from provided values", () => {
      expect(config.PORT).toBe(3999);
      expect(config.SUPABASE_JWT_SECRET).toBe("test-secret");
      expect(config.ENVIRONMENT).toBe("test");
      expect(config.DOCKER_HOST).toBe("/var/run/docker.sock");
      expect(config.CORS_ORIGINS).toEqual(["*"]);
    });

    it("should call process.exit when required env vars are missing", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {
          throw new Error("process.exit called");
        }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Clear required env vars
      const originalPort = process.env.PORT;
      const originalSecret = process.env.SUPABASE_JWT_SECRET;
      const originalEnv = process.env.ENVIRONMENT;
      delete process.env.PORT;
      delete process.env.SUPABASE_JWT_SECRET;
      delete process.env.ENVIRONMENT;

      expect(() => validateEnv()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing required environment variables")
      );

      // Restore
      process.env.PORT = originalPort;
      process.env.SUPABASE_JWT_SECRET = originalSecret;
      process.env.ENVIRONMENT = originalEnv;
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("should default DOCKER_HOST to /var/run/docker.sock when not set", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as never);

      const originalDockerHost = process.env.DOCKER_HOST;
      delete process.env.DOCKER_HOST;

      process.env.PORT = "4000";
      process.env.SUPABASE_JWT_SECRET = "secret";
      process.env.ENVIRONMENT = "dev";

      const result = validateEnv();
      expect(result.DOCKER_HOST).toBe("/var/run/docker.sock");

      // Restore
      if (originalDockerHost !== undefined) {
        process.env.DOCKER_HOST = originalDockerHost;
      }
      exitSpy.mockRestore();
    });

    it("should parse CORS_ORIGINS from comma-separated string", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as never);

      process.env.PORT = "4000";
      process.env.SUPABASE_JWT_SECRET = "secret";
      process.env.ENVIRONMENT = "dev";
      process.env.CORS_ORIGINS = "http://localhost:3000, https://panel.aivory.id";

      const result = validateEnv();
      expect(result.CORS_ORIGINS).toEqual([
        "http://localhost:3000",
        "https://panel.aivory.id",
      ]);

      delete process.env.CORS_ORIGINS;
      exitSpy.mockRestore();
    });
  });

  describe("GET /health", () => {
    it("should return JSON with status, uptime, and timestamp", async () => {
      const res = await request(app).get("/health");

      // On Windows/CI the Docker socket won't exist, so it may be unhealthy
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("timestamp");
      expect(typeof res.body.uptime).toBe("number");
      expect(typeof res.body.timestamp).toBe("string");
    });

    it("should include status field in response", async () => {
      const res = await request(app).get("/health");
      expect(["ok", "unhealthy"]).toContain(res.body.status);
    });

    it("should return unhealthy when Docker socket is unreachable", async () => {
      // Bootstrap with a non-existent socket path
      const unhealthy = bootstrap({
        PORT: 4001,
        SUPABASE_JWT_SECRET: "secret",
        DOCKER_HOST: "/nonexistent/docker.sock",
        ENVIRONMENT: "test",
        CORS_ORIGINS: ["*"],
      });

      const res = await request(unhealthy.app).get("/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
      expect(res.body.reasons).toBeDefined();
      expect(res.body.reasons.some((r: string) => r.includes("Docker socket unreachable"))).toBe(true);

      unhealthy.io.close();
      unhealthy.httpServer.close();
    });
  });

  describe("isDockerSocketReachable", () => {
    it("should return true for tcp:// hosts", () => {
      expect(isDockerSocketReachable("tcp://localhost:2375")).toBe(true);
    });

    it("should return true for http:// hosts", () => {
      expect(isDockerSocketReachable("http://docker-host:2375")).toBe(true);
    });

    it("should return false for non-existent socket paths", () => {
      expect(isDockerSocketReachable("/nonexistent/docker.sock")).toBe(false);
    });
  });

  describe("Express App Configuration", () => {
    it("should parse JSON body", async () => {
      const res = await request(app)
        .post("/nonexistent")
        .send({ test: true })
        .set("Content-Type", "application/json");

      // Should get 404, not 400/500 (body parsing works)
      expect(res.status).toBe(404);
    });
  });

  describe("Socket.IO Configuration", () => {
    it("should export io instance", () => {
      expect(io).toBeDefined();
    });

    it("should be a Socket.IO Server instance", () => {
      expect(io.constructor.name).toBe("Server");
    });
  });
});
