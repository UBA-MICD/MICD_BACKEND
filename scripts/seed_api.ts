import fs from "fs";
import path from "path";

const HEALTH_URL =
  process.env.API_HEALTH_URL || "http://micd-backend:3000/api/health";
const UPLOAD_URL =
  process.env.UPLOAD_URL || "http://micd-backend:3000/api/v1/studies/upload";
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
            `Backend degraded: ${data.error || "Unknown error"} - retrying...`,
          );
        }
      }
    } catch (e) {
      // Ignore connection error
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.error("Error: Backend not ready after retries.");
  return false;
}

async function seedData(dir: string, uploadUrl: string): Promise<boolean> {
  const files = getDicomFiles(dir);
  if (files.length === 0) {
    console.log("DICOM files not found in staging directory. Skipping upload.");
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

      const res = await fetch(`${uploadUrl}?force=true`, {
        method: "POST",
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
  const success = await seedData(STAGING_DIR, UPLOAD_URL);
  if (!success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error in seeding:", err);
  process.exit(1);
});
