/**
 * Redis Cache Layer
 * Protects against Geofox rate limits (max 1 req/sec)
 */

const Redis = require("ioredis");

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      retryDelayOnFailover: 1000,
      lazyConnect: false,
    });

    redis.on("error", (err) => {
      console.error("[Redis] Connection error:", err.message);
    });

    redis.on("connect", () => {
      console.log("[Redis] Connected");
    });
  }
  return redis;
}

/**
 * Get a value from cache.
 * Returns parsed JSON or null if not found / expired.
 */
async function get(key) {
  try {
    const val = await getRedis().get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    console.error("[Cache] GET error:", err.message);
    return null;
  }
}

/**
 * Set a value in cache with TTL in seconds.
 */
async function set(key, value, ttlSeconds = 60) {
  try {
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    console.error("[Cache] SET error:", err.message);
  }
}

/**
 * Delete a key from cache.
 */
async function del(key) {
  try {
    await getRedis().del(key);
  } catch (err) {
    console.error("[Cache] DEL error:", err.message);
  }
}

/**
 * Cached wrapper: if key exists return cached value,
 * otherwise call fn(), cache the result and return it.
 */
async function cached(key, ttlSeconds, fn) {
  const cached = await get(key);
  if (cached !== null) return cached;

  const fresh = await fn();
  await set(key, fresh, ttlSeconds);
  return fresh;
}

module.exports = { get, set, del, cached };
