import autocannon from 'autocannon';
import { randomBytes } from 'crypto';

// Configuration
const URL = 'http://localhost:3000/api/shorten';
const CONNECTIONS = 100;
const DURATION = 10; // seconds
const PIPELINING = 10; // Number of requests to pipeline

console.log(`Starting load test on ${URL}`);
console.log(`Connections: ${CONNECTIONS}, Duration: ${DURATION}s, Pipelining: ${PIPELINING}`);

// Generate a random URL for each request
const generateRandomUrl = () => {
  const randomId = randomBytes(8).toString('hex');
  return `https://example.com/very/long/path/${randomId}`;
};

// Run the load test
const instance = autocannon({
  url: URL,
  connections: CONNECTIONS,
  duration: DURATION,
  pipelining: PIPELINING,
  headers: {
    'content-type': 'application/json',
  },
  requests: [
    {
      method: 'POST',
      body: () => JSON.stringify({ url: generateRandomUrl() }),
    },
  ],
});

// Print the progress to console
autocannon.track(instance, { renderProgressBar: true });

// When the test is done
instance.on('done', (results) => {
  console.log('Load test completed!');
  console.log('Summary:');
  console.log(`Requests per second: ${results.requests.average}`);
  console.log(`Average latency: ${results.latency.average} ms`);
  console.log(`Max latency: ${results.latency.max} ms`);
  console.log(`Total requests: ${results.requests.total}`);
  console.log(`2xx responses: ${results.statusCodeStats['2xx']}`);
  console.log(`Non-2xx responses: ${results.requests.total - results.statusCodeStats['2xx']}`);

  // Calculate if we met the 1000 URLs/second requirement
  const urlsPerSecond = results.requests.average;
  console.log(`\nPerformance target: 1000+ URLs/second`);
  console.log(`Actual performance: ${urlsPerSecond.toFixed(2)} URLs/second`);

  if (urlsPerSecond >= 1000) {
    console.log('✅ Performance target achieved!');
  } else {
    console.log('❌ Performance target not met. Consider optimizing further.');
  }
});