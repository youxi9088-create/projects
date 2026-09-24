import { backfillHealthTrendPoints } from './db.js';

try {
  const result = backfillHealthTrendPoints({ days: 7 });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
