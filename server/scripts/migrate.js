import { ensureSchema } from '../config/schema.js';

const run = async () => {
  await ensureSchema();
  console.log('Social Genie migrations completed successfully');
  process.exit(0);
};

run().catch((error) => {
  console.error('Social Genie migration failed:', error);
  process.exit(1);
});
