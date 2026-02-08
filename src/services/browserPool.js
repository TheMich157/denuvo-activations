import { debug } from '../utils/debug.js';
import { DrmError } from './drm.js';
import BrowserAutomation from './browserAutomation.js';

const log = debug('browserPool');

/**
 * Browser pool for managing multiple browser instances efficiently
 * Reduces startup overhead and improves resource utilization
 */
class BrowserPool {
  constructor(options = {}) {
    this.options = {
      maxPoolSize: 3,
      maxIdleTime: 300000, // 5 minutes
      maxAge: 1800000, // 30 minutes
      healthCheckInterval: 60000, // 1 minute
      ...options
    };
    
    this.pool = new Map();
    this.available = [];
    this.inUse = new Set();
    this.healthCheckTimer = null;
    this.stats = {
      created: 0,
      destroyed: 0,
      reused: 0,
      errors: 0
    };
    
    this.startHealthCheck();
  }

  /**
   * Start periodic health checks
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);
  }

  /**
   * Stop health checks
   */
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Perform health check on pooled browsers
   */
  async performHealthCheck() {
    const now = Date.now();
    const toRemove = [];

    for (const [id, instance] of this.pool) {
      const age = now - instance.createdAt;
      const idleTime = now - instance.lastUsed;

      // Remove old or idle browsers
      if (age > this.options.maxAge || idleTime > this.options.maxIdleTime) {
        toRemove.push(id);
        continue;
      }

      // Check if browser is still responsive
      if (!this.inUse.has(id)) {
        try {
          await instance.browserInstance.page.evaluate(() => document.title);
        } catch (error) {
          log(`Browser instance ${id} failed health check:`, error.message);
          toRemove.push(id);
        }
      }
    }

    // Remove failed/old instances
    for (const id of toRemove) {
      await this.destroyInstance(id);
    }

    if (toRemove.length > 0) {
      log(`Health check removed ${toRemove.length} browser instances`);
    }
  }

  /**
   * Get a browser instance from the pool
   */
  async acquire(options = {}) {
    // Try to reuse an available instance
    if (this.available.length > 0) {
      const id = this.available.pop();
      const instance = this.pool.get(id);
      
      if (instance && !this.inUse.has(id)) {
        try {
          // Verify the instance is still healthy
          await instance.browserInstance.page.evaluate(() => document.title);
          
          this.inUse.add(id);
          instance.lastUsed = Date.now();
          this.stats.reused++;
          
          log(`Reused browser instance ${id}. Pool size: ${this.pool.size}, Available: ${this.available.length}, In use: ${this.inUse.size}`);
          return instance.browserInstance;
        } catch (error) {
          // Instance is not healthy, remove it
          log(`Removing unhealthy instance ${id}:`, error.message);
          await this.destroyInstance(id);
        }
      }
    }

    // Create new instance if pool not at max capacity
    if (this.pool.size < this.options.maxPoolSize) {
      const id = await this.createInstance(options);
      this.inUse.add(id);
      return this.pool.get(id).browserInstance;
    }

    // Pool is full, wait for an available instance
    return await this.waitForAvailable(options);
  }

  /**
   * Wait for an available browser instance
   */
  async waitForAvailable(options = {}) {
    const maxWait = 30000; // 30 seconds max wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (this.available.length > 0) {
        return await this.acquire(options);
      }
      
      // Check if any in-use instances can be cleaned up
      for (const id of this.inUse) {
        const instance = this.pool.get(id);
        if (instance && (Date.now() - instance.lastUsed) > this.options.maxIdleTime) {
          log(`Force releasing idle instance ${id}`);
          await this.release(id);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new DrmError('Browser pool timeout - no available instances', {
      step: 'browserPool:timeout',
      details: `Pool size: ${this.pool.size}, In use: ${this.inUse.size}`
    });
  }

  /**
   * Create a new browser instance
   */
  async createInstance(options = {}) {
    const id = `browser_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      const browserInstance = new BrowserAutomation({
        ...options,
        // Don't auto-cleanup when using pool
        autoCleanup: false
      });
      
      await browserInstance.init();
      
      const instance = {
        id,
        browserInstance,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        useCount: 0
      };
      
      this.pool.set(id, instance);
      this.stats.created++;
      
      log(`Created new browser instance ${id}. Pool size: ${this.pool.size}`);
      return id;
    } catch (error) {
      this.stats.errors++;
      throw new DrmError(`Failed to create browser instance: ${error.message}`, {
        step: 'browserPool:create',
        cause: error
      });
    }
  }

  /**
   * Release a browser instance back to the pool
   */
  async release(id) {
    const instance = this.pool.get(id);
    if (!instance) {
      log(`Attempted to release unknown instance ${id}`);
      return;
    }

    if (!this.inUse.has(id)) {
      log(`Instance ${id} is not in use`);
      return;
    }

    try {
      // Reset the browser state for next use
      await instance.browserInstance.page.evaluate(() => {
        // Clear any forms
        document.querySelectorAll('form').forEach(form => form.reset());
        // Clear any input fields
        document.querySelectorAll('input, textarea').forEach(input => {
          input.value = '';
        });
      });

      // Clear cookies and storage for privacy
      await instance.browserInstance.page.evaluate(() => {
        if (window.localStorage) {
          window.localStorage.clear();
        }
        if (window.sessionStorage) {
          window.sessionStorage.clear();
        }
      });

      instance.lastUsed = Date.now();
      instance.useCount++;
      
      this.inUse.delete(id);
      this.available.push(id);
      
      log(`Released browser instance ${id}. Available: ${this.available.length}`);
    } catch (error) {
      log(`Error releasing instance ${id}:`, error.message);
      // If we can't properly release it, destroy it
      await this.destroyInstance(id);
    }
  }

  /**
   * Destroy a browser instance
   */
  async destroyInstance(id) {
    const instance = this.pool.get(id);
    if (!instance) return;

    try {
      await instance.browserInstance.cleanup();
      this.pool.delete(id);
      this.inUse.delete(id);
      
      // Remove from available list
      const availableIndex = this.available.indexOf(id);
      if (availableIndex > -1) {
        this.available.splice(availableIndex, 1);
      }
      
      this.stats.destroyed++;
      log(`Destroyed browser instance ${id}`);
    } catch (error) {
      log(`Error destroying instance ${id}:`, error.message);
      // Force removal from pool even if cleanup failed
      this.pool.delete(id);
      this.inUse.delete(id);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      poolSize: this.pool.size,
      available: this.available.length,
      inUse: this.inUse.size,
      maxPoolSize: this.options.maxPoolSize
    };
  }

  /**
   * Clear all browser instances
   */
  async clear() {
    log('Clearing browser pool...');
    
    const allIds = Array.from(this.pool.keys());
    for (const id of allIds) {
      await this.destroyInstance(id);
    }
    
    this.stopHealthCheck();
    log('Browser pool cleared');
  }

  /**
   * Wrapper function for browser operations with pool management
   */
  async withBrowser(operation, options = {}) {
    let browser = null;
    let instanceId = null;
    
    try {
      browser = await this.acquire(options);
      instanceId = this.findInstanceId(browser);
      
      const result = await operation(browser);
      
      return result;
    } finally {
      if (instanceId && this.pool.has(instanceId)) {
        await this.release(instanceId);
      } else if (browser) {
        // Fallback cleanup if we can't find the instance
        try {
          await browser.cleanup();
        } catch (e) {
          log('Fallback cleanup failed:', e.message);
        }
      }
    }
  }

  /**
   * Find the instance ID for a browser instance
   */
  findInstanceId(browserInstance) {
    for (const [id, instance] of this.pool) {
      if (instance.browserInstance === browserInstance) {
        return id;
      }
    }
    return null;
  }
}

// Global pool instance
let globalPool = null;

/**
 * Get or create the global browser pool
 */
export function getBrowserPool(options = {}) {
  if (!globalPool) {
    globalPool = new BrowserPool(options);
  }
  return globalPool;
}

/**
 * Enhanced function using browser pool
 */
export async function generateDrmCodeWithBrowserPool(appId, credentials, confirmCode = null, options = {}) {
  const pool = getBrowserPool();
  
  return await pool.withBrowser(async (browser) => {
    // Login to Steam if needed
    await browser.steamLogin(credentials, confirmCode);
    
    // Generate DRM code
    const code = await browser.generateDrmCode(appId);
    
    return code;
  }, options);
}

/**
 * Cleanup global pool on process exit
 */
process.on('SIGINT', async () => {
  if (globalPool) {
    await globalPool.clear();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (globalPool) {
    await globalPool.clear();
  }
  process.exit(0);
});

export default BrowserPool;
