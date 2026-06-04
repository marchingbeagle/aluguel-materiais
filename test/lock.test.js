"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const lock = require("../src/main/lock");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aluguel-materiais-lock-"));
}

describe("lock", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("withLock creates the lock while running and removes it after success", async () => {
    const lockFile = path.join(tempDir, lock.LOCK_NAME);

    const result = await lock.withLock(tempDir, "user-1", async () => {
      expect(fs.existsSync(lockFile)).toBe(true);
      const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      expect(info.userId).toBe("user-1");
      return "saved";
    });

    expect(result).toBe("saved");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test("withLock releases the lock when the protected function throws", async () => {
    const lockFile = path.join(tempDir, lock.LOCK_NAME);

    await expect(
      lock.withLock(tempDir, "user-1", async () => {
        expect(fs.existsSync(lockFile)).toBe(true);
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");

    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
