import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFeed } from '../src/feed.js';

dotenv.config();

const outputDir = path.resolve('public');
const feedPath = path.join(outputDir, 'feed.csv');
const metadataPath = path.join(outputDir, 'feed-meta.json');

try {
  const generatedAt = new Date();
  const { csv, rowCount, productCount } = await generateFeed(process.env, {
    onProgress: ({ step, current, total, message }) => {
      const count = total ? `${current}/${total}` : `${current}`;
      console.log(`[${step}] ${count} ${message ?? ''}`.trim());
    }
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(feedPath, csv, 'utf8');
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        generatedAt: generatedAt.toISOString(),
        productCount,
        rowCount,
        file: 'feed.csv'
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  console.log(`Wrote ${feedPath}`);
  console.log(`Wrote ${metadataPath}`);
  console.log(`Generated ${rowCount} CSV rows for ${productCount} products.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
