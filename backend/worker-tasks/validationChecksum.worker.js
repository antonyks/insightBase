const crypto = require('node:crypto');

function runValidationChecksum(input) {
  const seed = String(input.seed);
  const iterations = Number(input.iterations);

  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('iterations must be a positive integer');
  }

  let checksum = seed;
  for (let index = 0; index < iterations; index += 1) {
    checksum = crypto
      .createHash('sha256')
      .update(checksum)
      .update(':')
      .update(String(index))
      .digest('hex');
  }

  return {
    checksum,
    iterations,
    seedLength: seed.length,
  };
}

module.exports = {
  runValidationChecksum,
};
