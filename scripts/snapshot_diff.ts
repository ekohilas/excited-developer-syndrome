import { $ } from "bun";
import { readdir, unlink, mkdir, rename, rm } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const EXPORT_DIR = "slides-export";
const TMP_DIR = "tmp-snapshots";

/**
 * Utility to read a PNG file into a buffer
 */
async function readPNG(path: string): Promise<PNG> {
  const data = await Bun.file(path).arrayBuffer();
  return PNG.sync.read(Buffer.from(data));
}

/**
 * Cleans up previous runs
 */
async function setupWorkspace(exportDir: string, tmpDir: string) {
  // Remove tmp directory if it exists
  await rm(tmpDir, { recursive: true, force: true });
  
  // Remove all *.new.png in the export directory
  const files = await readdir(exportDir).catch(() => []);
  const cleanupTasks = files
    .filter(f => f.endsWith(".new.png"))
    .map(f => unlink(join(exportDir, f)));
  
  await Promise.all(cleanupTasks);
  await mkdir(tmpDir, { recursive: true });
}

/**
 * Runs the Slidev export command
 */
async function runSlidevExport(outputDir: string) {
  console.log("🚀 Exporting slides...");
  const result = await $`bunx slidev export --format png --with-clicks --output ${outputDir}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error("Slidev export failed");
  }
}

/**
 * Moves and renames files from tmp to final export dir
 */
async function processNewSnapshots(srcDir: string, destDir: string): Promise<string[]> {
  const files = await readdir(srcDir);
  const newFiles: string[] = [];

  for (const file of files) {
    if (extname(file) === ".png") {
      const newName = file.replace(".png", ".new.png");
      await rename(join(srcDir, file), join(destDir, newName));
      newFiles.push(newName);
    }
  }
  return newFiles;
}

/**
 * Compares two PNG files and returns the number of different pixels
 */
async function compareImages(pathA: string, pathB: string): Promise<number> {
  const img1 = await readPNG(pathA);
  const img2 = await readPNG(pathB);

  if (img1.width !== img2.width || img1.height !== img2.height) {
    return Infinity; // Layout size change is a definite difference
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  return pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    threshold: 0.1,
  });
}

/**
 * Main execution logic
 */
async function main() {
  try {
    await setupWorkspace(EXPORT_DIR, TMP_DIR);
    await runSlidevExport(TMP_DIR);
    const newSnapshots = await processNewSnapshots(TMP_DIR, EXPORT_DIR);
    
    // Get all existing baseline files (files ending in .png but NOT .new.png)
    const allFiles = await readdir(EXPORT_DIR);
    const baselines = allFiles.filter(f => f.endsWith(".png") && !f.endsWith(".new.png"));

    // We check the union of slide numbers (baselines vs news)
    const slideIdentifiers = new Set([
      ...baselines.map(f => f.replace(".png", "")),
      ...newSnapshots.map(f => f.replace(".new.png", ""))
    ]);

    let hasDifference = false;

    console.log(`\n🔍 Comparing ${slideIdentifiers.size} slides...`);

    for (const id of Array.from(slideIdentifiers).sort()) {
      const baselinePath = join(EXPORT_DIR, `${id}.png`);
      const newPath = join(EXPORT_DIR, `${id}.new.png`);

      const baselineExists = await Bun.file(baselinePath).exists();
      const newExists = await Bun.file(newPath).exists();

      if (!baselineExists) {
        console.log(`⚠️  [${id}] Baseline missing. (New slide added)`);
        hasDifference = true;
        continue;
      }

      if (!newExists) {
        console.log(`⚠️  [${id}] New export missing. (Slide removed)`);
        hasDifference = true;
        continue;
      }

      const diffPixels = await compareImages(baselinePath, newPath);
      
      if (diffPixels > 0) {
        console.log(`❌ [${id}] Differences detected! (${diffPixels} pixels)`);
        hasDifference = true;
      } else {
        console.log(`✅ [${id}] No changes.`);
      }
    }

    // Final Cleanup
    await rm(TMP_DIR, { recursive: true, force: true });

    if (hasDifference) {
      console.error("\nVisual regression check failed.");
      process.exit(1);
    } else {
      console.log("\nVisual regression check passed!");
      process.exit(0);
    }

  } catch (error) {
    console.error("Error during diff execution:", error);
    process.exit(1);
  }
}

main();
