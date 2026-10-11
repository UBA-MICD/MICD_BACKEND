/**
 * Route-matrix authorization test. Walks each feature router's stack and asserts
 * that every authenticated route carries the exact requireRole guard the RBAC
 * design specifies — the same router-stack introspection idiom used by
 * health.routes.test.ts, no live HTTP server needed.
 *
 * This is the suite that runs on every PR (CI never boots the server), so the
 * full 32-route matrix is proven here rather than only in the integration layer.
 */
import type { Router } from "express";
import { studiesRouter } from "../../src/modules/studies/studies.routes";
import { uploadRouter } from "../../src/modules/upload/upload.routes";
import activityRouter from "../../src/modules/activity/activity.routes";
import { zenodoRouter } from "../../src/modules/zenodo/zenodo.routes";
import { segmentationRouter } from "../../src/modules/segmentation/segmentation.routes";
import { pathologiesRouter } from "../../src/modules/pathologies/pathologies.routes";
import { ROLES, Role } from "../../src/shared/roles";

const ALL = [...ROLES];
const VIEW: Role[] = ["admin", "medico", "investigador"];
const DOWNLOAD: Role[] = ["admin", "medico", "investigador", "informatico"];
const UPLOADERS: Role[] = ["admin", "medico", "informatico"];
const STAFF: Role[] = ["admin", "medico"];
const ADMIN: Role[] = ["admin"];

type Method = "get" | "post" | "put" | "delete";
interface Expected {
  method: Method;
  path: string;
  roles: Role[];
}

/** The allowed roles declared on a route's requireRole guard, if any. */
function guardRolesFor(
  router: Router,
  method: Method,
  path: string,
): Role[] | undefined {
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  const handles: any[] = layer?.route?.stack?.map((s: any) => s.handle) ?? [];
  return handles.find((h) => Array.isArray(h?.roles))?.roles;
}

/** Count of distinct (method, path) route entries carrying a role guard. */
function gatedRouteCount(router: Router): number {
  let n = 0;
  for (const l of router.stack as any[]) {
    if (!l.route) continue;
    const guarded = l.route.stack?.some((s: any) =>
      Array.isArray(s.handle?.roles),
    );
    if (guarded) n += Object.keys(l.route.methods).length;
  }
  return n;
}

const studies: Expected[] = [
  { method: "get", path: "/api/studies", roles: VIEW },
  { method: "get", path: "/api/studies/:id", roles: VIEW },
  { method: "delete", path: "/api/studies/:id", roles: ADMIN },
  { method: "get", path: "/api/v1/studies/:studyId/file", roles: DOWNLOAD },
  { method: "get", path: "/api/v1/studies/:studyId/instances", roles: DOWNLOAD },
  {
    method: "get",
    path: "/api/v1/studies/:studyId/instances/:instanceId/file",
    roles: DOWNLOAD,
  },
  { method: "get", path: "/api/v1/studies", roles: DOWNLOAD },
  { method: "get", path: "/api/v1/studies/:studyId/zenodo", roles: VIEW },
  {
    method: "post",
    path: "/api/v1/studies/:studyId/zenodo/check",
    roles: STAFF,
  },
  { method: "get", path: "/api/v1/studies/:studyId/thumbnail", roles: VIEW },
  { method: "get", path: "/api/v1/studies/:studyId/validation", roles: VIEW },
  { method: "post", path: "/api/v1/studies/:studyId/validate", roles: STAFF },
  {
    method: "post",
    path: "/api/v1/studies/:studyId/validation-correction",
    roles: ADMIN,
  },
  {
    method: "post",
    path: "/api/v1/studies/:studyId/ml/analyze",
    roles: ADMIN,
  },
  {
    method: "get",
    path: "/api/v1/studies/:studyId/ml/prediction",
    roles: VIEW,
  },
];

const upload: Expected[] = [
  { method: "post", path: "/api/v1/studies/upload", roles: UPLOADERS },
  { method: "post", path: "/api/instances", roles: UPLOADERS },
];

const activity: Expected[] = [
  { method: "get", path: "/", roles: ADMIN },
  { method: "get", path: "/export", roles: ADMIN },
];

const zenodo: Expected[] = [
  { method: "post", path: "/config", roles: ADMIN },
  { method: "delete", path: "/config/:environment", roles: ADMIN },
  { method: "get", path: "/config/status", roles: STAFF },
  { method: "get", path: "/health", roles: STAFF },
  { method: "get", path: "/search", roles: VIEW },
  { method: "get", path: "/records/:recordId", roles: VIEW },
  { method: "get", path: "/config/sync", roles: ADMIN },
  { method: "put", path: "/config/sync", roles: ADMIN },
  { method: "post", path: "/config/sync/run", roles: ADMIN },
  { method: "get", path: "/config/sync/logs", roles: STAFF },
  { method: "get", path: "/config/sync/status", roles: STAFF },
  { method: "post", path: "/import", roles: STAFF },
  { method: "get", path: "/imports/:importId", roles: STAFF },
  { method: "get", path: "/resolve", roles: VIEW },
  { method: "get", path: "/quota", roles: STAFF },
  { method: "post", path: "/publish", roles: ADMIN },
  { method: "get", path: "/depositions/:depositionId", roles: ADMIN },
  { method: "post", path: "/depositions/:depositionId/retry", roles: ADMIN },
];

const segmentation: Expected[] = [
  { method: "post", path: "/segmentation", roles: VIEW },
  { method: "get", path: "/segmentation", roles: VIEW },
  { method: "get", path: "/segmentation/:id/corrections", roles: VIEW },
  { method: "post", path: "/segmentation/:id/corrections", roles: ["medico", "admin"] },
  { method: "post", path: "/segmentation/:id/accept", roles: ["medico", "admin"] },
  { method: "post", path: "/segmentation/:id/discard", roles: ["medico", "admin"] },
];

const pathologies: Expected[] = [{ method: "get", path: "/", roles: ALL }];

const suites: Array<[string, Router, Expected[]]> = [
  ["studies", studiesRouter, studies],
  ["upload", uploadRouter, upload],
  ["activity", activityRouter, activity],
  ["zenodo", zenodoRouter, zenodo],
  ["segmentation", segmentationRouter, segmentation],
  ["pathologies", pathologiesRouter, pathologies],
];

describe("RBAC route matrix", () => {
  for (const [name, router, expected] of suites) {
    describe(name, () => {
      it.each(expected)("$method $path → $roles", ({ method, path, roles }) => {
        expect(guardRolesFor(router, method, path)).toEqual(roles);
      });

      it("gates exactly the expected number of routes (no unguarded route)", () => {
        expect(gatedRouteCount(router)).toBe(expected.length);
      });
    });
  }

  it("gates 44 authenticated endpoints in total", () => {
    const total = suites.reduce((sum, [, r]) => sum + gatedRouteCount(r), 0);
    expect(total).toBe(44);
  });

  it("informatico reaches only upload, study list/download and the pathology catalog", () => {
    const allowed = suites.flatMap(([name, router, expected]) =>
      expected
        .filter(({ method, path }) =>
          guardRolesFor(router, method, path)?.includes("informatico"),
        )
        .map(({ method, path }) => `${name} ${method} ${path}`),
    );
    expect(allowed.sort()).toEqual(
      [
        "pathologies get /",
        "studies get /api/v1/studies",
        "studies get /api/v1/studies/:studyId/file",
        "studies get /api/v1/studies/:studyId/instances",
        "studies get /api/v1/studies/:studyId/instances/:instanceId/file",
        "upload post /api/instances",
        "upload post /api/v1/studies/upload",
      ].sort(),
    );
  });
});
