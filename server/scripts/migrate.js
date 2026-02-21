import { ensureSchema } from '../config/schema.js';

const run = async () => {
  await ensureSchema();
  console.log('Meta Genie migrations completed successfully');
  process.exit(0);
};

run().catch((error) => {
  console.error('Meta Genie migration failed:', error);
  process.exit(1);
});
