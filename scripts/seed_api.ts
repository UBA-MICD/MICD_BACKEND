import "dotenv/config";
import fs from "fs";
import path from "path";

const BACKEND_HOST = process.env.BACKEND_HOST || "micd-backend";
const PORT = process.env.PORT || process.env.BACKEND_PORT || "3000";
const API_BASE_URL = `http://${BACKEND_HOST}:${PORT}`;

const HEALTH_URL = process.env.API_HEALTH_URL || `${API_BASE_URL}/api/health`;
const UPLOAD_URL =
  process.env.UPLOAD_URL || `${API_BASE_URL}/api/v1/studies/upload`;
const STAGING_DIR = process.env.STAGING_DIR || "./data/staging/dicom";

function getDicomFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getDicomFiles(filePath));
    } else if (file.endsWith(".dcm")) {
      results.push(filePath);
    }
  });
  return results;
}

async function waitForBackend(
  url: string,
  retries = 40,
  delayMs = 2000,
): Promise<boolean> {
  console.log(`Waiting for backend at ${url}...`);
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        const data = (await res.json()) as any;
        if (data.status === "ok") {
          console.log("Backend and Orthanc ready!");
          return true;
        } else {
          console.log(
            `Backend available but degraded: ${data.error || "no details"}`,
          );
        }
      }
    } catch (e) {
      // Ignore connection error
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.error("Error: Backend is not ready.");
  return false;
}

async function getAuthToken(baseUrl: string): Promise<string | null> {
  const email =
    process.env.SEED_EMAIL || process.env.ADMIN_EMAIL || "test@micd.local";
  const passwordsToTry = Array.from(
    new Set([
      process.env.SEED_PASSWORD,
      "testpassword",
      process.env.ADMIN_PASSWORD,
    ]),
  ).filter((p): p is string => Boolean(p));

  const loginUrl = `${baseUrl}/auth/login`;

  for (const password of passwordsToTry) {
    console.log(`Authenticating with backend as ${email}...`);
    try {
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (res.status === 200) {
        const data = (await res.json()) as { accessToken?: string };
        if (data.accessToken) {
          console.log("Authentication successful!");
          return data.accessToken;
        }
      }
    } catch (e) {
      console.error("Error logging in to backend:", e);
    }
  }
  console.error("Login failed: All credential attempts failed.");
  return null;
}

async function seedData(
  dir: string,
  uploadUrl: string,
  token: string,
): Promise<boolean> {
  const files = getDicomFiles(dir);
  if (files.length === 0) {
    console.log("No DICOM files found to upload.");
    return true;
  }

  console.log(`Uploading ${files.length} DICOM files...`);
  let successCount = 0;

  for (const filePath of files) {
    try {
      const buffer = fs.readFileSync(filePath);
      const blob = new Blob([buffer], { type: "application/dicom" });
      const formData = new FormData();
      formData.append("file", blob, path.basename(filePath));

      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const res = await fetch(`${uploadUrl}?force=true`, {
        method: "POST",
        headers,
        body: formData,
      });

      if (res.status === 200 || res.status === 201) {
        successCount++;
      } else if (res.status === 409) {
        console.log(`Already uploaded: ${path.basename(filePath)}`);
        successCount++;
      } else {
        const text = await res.text();
        console.error(
          `Error uploading ${path.basename(filePath)}: ${res.status} - ${text}`,
        );
      }
    } catch (e) {
      console.error(`Failed to upload ${path.basename(filePath)}:`, e);
    }
  }

  console.log(`Upload complete. ${successCount}/${files.length} uploaded.`);
  return successCount === files.length;
}

async function main() {
  const ready = await waitForBackend(HEALTH_URL);
  if (!ready) {
    process.exit(1);
  }
  const token = await getAuthToken(API_BASE_URL);
  if (!token) {
    console.error("Failed to authenticate. Exiting seeding.");
    process.exit(1);
  }
  const success = await seedData(STAGING_DIR, UPLOAD_URL, token);
  if (!success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error on seeding:", err);
  process.exit(1);
});
