/**
 * Unit tests for the invite mailer's no-SMTP fallback: with SMTP_HOST unset it
 * must log the invite link to stdout and resolve (never throw), and the link is
 * built from APP_BASE_URL with the code URL-encoded. Sending over a real SMTP
 * connection is out of scope for a unit test.
 */
import { sendInvite, inviteLink } from "../../../src/shared/mailer";

describe("inviteLink", () => {
  const saved = process.env.APP_BASE_URL;
  afterEach(() => {
    process.env.APP_BASE_URL = saved;
  });

  it("builds APP_BASE_URL/?invite=<code> with the code encoded", () => {
    process.env.APP_BASE_URL = "https://micd.example";
    expect(inviteLink("ab/c+d")).toBe("https://micd.example/?invite=ab%2Fc%2Bd");
  });
});

describe("sendInvite without SMTP configured", () => {
  const savedHost = process.env.SMTP_HOST;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.SMTP_HOST;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    if (savedHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = savedHost;
  });

  it("logs the invite link instead of throwing", async () => {
    await expect(
      sendInvite("new@micd.local", "the-code"),
    ).resolves.toBeUndefined();
    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("new@micd.local");
    expect(logged).toContain("the-code");
  });
});
