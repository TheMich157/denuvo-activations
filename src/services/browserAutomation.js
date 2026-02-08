import puppeteer from 'puppeteer';
import { debug } from '../utils/debug.js';
import { DrmError } from './drm.js';
import { drmConfig } from '../config/drm.config.js';

const log = debug('browserAutomation');

/**
 * Enhanced Chromium-based Steam authentication and DRM automation
 * Features retry mechanisms, performance optimizations, and advanced error recovery
 */

class BrowserAutomation {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.options = {
      maxRetries: 3,
      retryDelay: 2000,
      navigationTimeout: 30000,
      elementTimeout: 10000,
      headless: true,
      ...options
    };
    this.attemptCount = 0;
  }

  /**
   * Initialize browser with enhanced stealth and performance settings
   */
  async init() {
    try {
      log(`Initializing browser (attempt ${this.attemptCount + 1})`);
      
      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-networking',
          '--window-size=1920,1080',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-images',
          '--disable-javascript-harmony-shipping',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection',
          '--memory-pressure-off'
        ]
      });

      this.page = await this.browser.newPage();
      
      // Enhanced stealth settings
      await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await this.page.setViewport({ width: 1920, height: 1080 });
      
      // Set extra headers to look more human
      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      });

      // Advanced request interception
      await this.page.setRequestInterception(true);
      this.page.on('request', (req) => {
        const resourceType = req.resourceType();
        // Block unnecessary resources for performance
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else if (['script'].includes(resourceType) && !req.url().includes('steamcommunity') && !req.url().includes('drm.steam.run')) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Add performance monitoring
      this.page.on('response', (response) => {
        if (response.status() >= 400) {
          log(`HTTP Error: ${response.status()} for ${response.url()}`);
        }
      });

      log('Browser initialized successfully with enhanced settings');
    } catch (error) {
      log('Failed to initialize browser:', error.message);
      throw new DrmError('Failed to initialize browser automation', {
        step: 'browser:init',
        cause: error
      });
    }
  }

  /**
   * Robust element waiting with multiple strategies
   */
  async waitForElement(selector, options = {}) {
    const { timeout = this.options.elementTimeout, visible = true } = options;
    
    try {
      await this.page.waitForSelector(selector, { timeout, visible });
      return await this.page.$(selector);
    } catch (error) {
      // Try alternative selectors
      const alternatives = this.getAlternativeSelectors(selector);
      for (const alt of alternatives) {
        try {
          await this.page.waitForSelector(alt, { timeout: 5000, visible });
          return await this.page.$(alt);
        } catch (e) {
          continue;
        }
      }
      throw error;
    }
  }

  /**
   * Get alternative selectors for common elements
   */
  getAlternativeSelectors(original) {
    const alternatives = {
      '#steamAccountName': ['input[name="username"]', 'input[type="text"]', 'input[placeholder*="username"]'],
      '#password': ['input[name="password"]', 'input[type="password"]'],
      '#twofactorcode_entry': ['input[name="code"]', 'input[placeholder*="code"]', 'input[name="twofactor"]'],
      '#login_btn_signin': ['button[type="submit"]', 'input[type="submit"]', 'button:contains("Sign in")'],
      'input[name="appid"]': ['input[name="app_id"]', 'input[placeholder*="App ID"]', 'input[id*="app"]'],
      'button[type="submit"]': ['button:contains("Generate")', 'button:contains("Create")', 'input[type="submit"]']
    };
    
    return alternatives[original] || [];
  }

  /**
   * Retry wrapper for browser operations
   */
  async withRetry(operation, context = 'operation') {
    let lastError;
    
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        log(`Attempting ${context} (attempt ${attempt}/${this.options.maxRetries})`);
        const result = await operation();
        if (attempt > 1) {
          log(`${context} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        log(`${context} failed on attempt ${attempt}: ${error.message}`);
        
        if (attempt < this.options.maxRetries) {
          // Take screenshot for debugging
          await this.takeScreenshot(`error-${context}-attempt-${attempt}.png`);
          
          // Wait before retry with exponential backoff
          const delay = this.options.retryDelay * Math.pow(2, attempt - 1);
          log(`Waiting ${delay}ms before retry...`);
          await this.page.waitForTimeout(delay);
          
          // Try to recover by refreshing or navigating back
          await this.attemptRecovery();
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Attempt recovery from errors
   */
  async attemptRecovery() {
    try {
      const currentUrl = this.page.url();
      
      // If we're stuck on a login page, try refreshing
      if (currentUrl.includes('login')) {
        await this.page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
      }
      // If we're on Steam but stuck, try going back
      else if (currentUrl.includes('steamcommunity.com')) {
        await this.page.goBack();
      }
      // Otherwise, try navigating to the target site
      else {
        await this.page.goto(drmConfig.baseUrl, { waitUntil: 'networkidle2', timeout: 15000 });
      }
    } catch (error) {
      log('Recovery attempt failed:', error.message);
    }
  }

  /**
   * Enhanced Steam login with better error handling
   */
  async steamLogin(credentials, confirmCode = null) {
    if (!this.page) throw new Error('Browser not initialized');

    return await this.withRetry(async () => {
      log('Starting enhanced Steam login via browser');
      
      // Navigate to Steam login with better error handling
      await this.page.goto('https://steamcommunity.com/login/', { 
        waitUntil: 'networkidle2',
        timeout: this.options.navigationTimeout 
      });

      // Wait and verify login form
      const usernameInput = await this.waitForElement('#steamAccountName');
      await usernameInput.click({ clickCount: 3 }); // Clear any existing text
      await usernameInput.type(credentials.username, { delay: 50 });

      const passwordInput = await this.waitForElement('#password');
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(credentials.password, { delay: 50 });

      // Handle 2FA if provided
      if (confirmCode) {
        try {
          const codeInput = await this.waitForElement('#twofactorcode_entry', { timeout: 5000 });
          if (codeInput) {
            await codeInput.click({ clickCount: 3 });
            await codeInput.type(confirmCode, { delay: 50 });
          }
        } catch (e) {
          log('2FA input not found, continuing without it');
        }
      }

      // Click login button with verification
      const loginButton = await this.waitForElement('#login_btn_signin');
      await loginButton.click();

      // Wait for navigation with multiple possible outcomes
      await this.page.waitForNavigation({ 
        waitUntil: 'networkidle2', 
        timeout: this.options.navigationTimeout 
      });

      // Verify login success
      const currentUrl = this.page.url();
      
      if (currentUrl.includes('login/home')) {
        log('Steam login successful via browser');
        return true;
      } else if (currentUrl.includes('login')) {
        // Check for specific error messages
        const errorSelectors = ['.form_error', '#error_text', '.login_error'];
        let errorMessage = 'Unknown login error';
        
        for (const selector of errorSelectors) {
          try {
            const errorElement = await this.page.$(selector);
            if (errorElement) {
              errorMessage = await errorElement.evaluate(el => el.textContent?.trim());
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        if (errorMessage.toLowerCase().includes('guard') || errorMessage.toLowerCase().includes('code')) {
          throw new DrmError('2FA code required for Steam login', {
            step: 'browser:steamLogin:2fa',
            details: errorMessage
          });
        } else if (errorMessage.toLowerCase().includes('incorrect') || errorMessage.toLowerCase().includes('invalid')) {
          throw new DrmError('Steam login failed - incorrect credentials', {
            step: 'browser:steamLogin:credentials',
            details: errorMessage
          });
        } else {
          throw new DrmError(`Steam login failed: ${errorMessage}`, {
            step: 'browser:steamLogin:failed',
            details: errorMessage
          });
        }
      }

      return true;
    }, 'Steam login');
  }

  /**
   * Enhanced DRM code generation with multiple extraction strategies
   */
  async generateDrmCode(appId) {
    if (!this.page) throw new Error('Browser not initialized');

    return await this.withRetry(async () => {
      log('Generating DRM code via enhanced browser automation for AppID:', appId);

      // Navigate to DRM site
      await this.page.goto(drmConfig.baseUrl, { 
        waitUntil: 'networkidle2',
        timeout: this.options.navigationTimeout 
      });

      // Wait for page to fully load
      await this.page.waitForTimeout(2000);

      // Check if already logged in and handle login if needed
      const loginLink = await this.page.$('a[href*="steam_login"]');
      if (loginLink) {
        log('Not logged into DRM, clicking login link');
        await loginLink.click();
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: this.options.navigationTimeout });
        await this.page.waitForTimeout(2000);
      }

      // Enhanced App ID input with multiple strategies
      let appIdEntered = false;
      const appIdStrategies = [
        // Direct input
        async () => {
          const input = await this.waitForElement('input[name="appid"], input[name="app_id"], input[placeholder*="App ID"]');
          await input.click({ clickCount: 3 });
          await input.type(appId.toString(), { delay: 50 });
          return true;
        },
        // Dropdown selection
        async () => {
          const select = await this.waitForElement('select[name="game"], select[name="appid"]');
          await select.click();
          await this.page.waitForTimeout(500);
          
          const options = await this.page.$$('option');
          for (const option of options) {
            const text = await option.evaluate(el => el.textContent);
            if (text.includes(appId.toString())) {
              await option.click();
              return true;
            }
          }
          return false;
        },
        // Game search
        async () => {
          const searchInput = await this.waitForElement('input[type="search"], input[placeholder*="search"]');
          await searchInput.click({ clickCount: 3 });
          await searchInput.type(appId.toString(), { delay: 50 });
          await this.page.waitForTimeout(1000);
          
          // Click first result
          const firstResult = await this.page.$('.game-option, .search-result, option');
          if (firstResult) {
            await firstResult.click();
            return true;
          }
          return false;
        }
      ];

      for (const strategy of appIdStrategies) {
        try {
          appIdEntered = await strategy();
          if (appIdEntered) break;
        } catch (e) {
          log('App ID strategy failed:', e.message);
          continue;
        }
      }

      if (!appIdEntered) {
        throw new DrmError('Could not enter App ID using any available method', {
          step: 'browser:appIdInput'
        });
      }

      // Enhanced code generation with multiple button strategies
      const buttonStrategies = [
        // Standard submit button
        async () => {
          const button = await this.waitForElement('button[type="submit"], input[type="submit"]');
          await button.click();
          return true;
        },
        // Generate button by text
        async () => {
          const buttons = await this.page.$$('button');
          for (const button of buttons) {
            const text = await button.evaluate(el => el.textContent?.toLowerCase());
            if (text?.includes('generate') || text?.includes('create')) {
              await button.click();
              return true;
            }
          }
          return false;
        },
        // Any clickable element
        async () => {
          const clickables = await this.page.$$('button, input[type="submit"], a.btn');
          for (const clickable of clickables) {
            try {
              await clickable.click();
              await this.page.waitForTimeout(2000);
              
              // Check if anything changed on the page
              const newUrl = this.page.url();
              if (newUrl !== this.page.url()) {
                return true;
              }
            } catch (e) {
              continue;
            }
          }
          return false;
        }
      ];

      let buttonClicked = false;
      for (const strategy of buttonStrategies) {
        try {
          buttonClicked = await strategy();
          if (buttonClicked) break;
        } catch (e) {
          log('Button strategy failed:', e.message);
          continue;
        }
      }

      if (buttonClicked) {
        // Wait for potential navigation
        try {
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
        } catch (e) {
          // Navigation might not be needed, continue
        }
      }

      // Wait for code generation
      await this.page.waitForTimeout(3000);

      // Enhanced code extraction with multiple strategies
      const code = await this.extractCode();
      
      if (code) {
        log('DRM code generated via enhanced browser automation:', code);
        return code;
      } else {
        throw new DrmError('Could not extract authorization code using any extraction method', {
          step: 'browser:extractCode'
        });
      }
    }, 'DRM code generation');
  }

  /**
   * Enhanced code extraction with multiple strategies
   */
  async extractCode() {
    const extractionStrategies = [
      // Direct input/textarea values
      async () => {
        const selectors = [
          'input[name="code"]',
          'textarea[name="code"]',
          '#code',
          '.code',
          '.auth-code',
          '.authorization-code',
          'input[placeholder*="code"]'
        ];
        
        for (const selector of selectors) {
          try {
            const element = await this.page.$(selector);
            if (element) {
              const value = await element.evaluate(el => el.value || el.textContent);
              if (value && value.trim()) {
                return value.trim();
              }
            }
          } catch (e) {
            continue;
          }
        }
        return null;
      },
      
      // Text content extraction
      async () => {
        const textSelectors = [
          '.code-display',
          '.auth-code-display',
          '[data-code]',
          '.generated-code'
        ];
        
        for (const selector of textSelectors) {
          try {
            const element = await this.page.$(selector);
            if (element) {
              const text = await element.evaluate(el => el.textContent);
              if (text && text.trim()) {
                return text.trim();
              }
            }
          } catch (e) {
            continue;
          }
        }
        return null;
      },
      
      // Pattern matching in body text
      async () => {
        const bodyText = await this.page.evaluate(() => document.body.textContent);
        
        // Look for 6-character alphanumeric codes
        const patterns = [
          /\b[A-Za-z0-9]{6}\b/g,
          /\b[A-Z0-9]{8}\b/g,
          /code[:\s]+([A-Za-z0-9]{6,})/gi,
          /auth[:\s]+([A-Za-z0-9]{6,})/gi
        ];
        
        for (const pattern of patterns) {
          const matches = bodyText.match(pattern);
          if (matches && matches.length > 0) {
            return matches[0].trim();
          }
        }
        return null;
      },
      
      // Advanced DOM traversal
      async () => {
        return await this.page.evaluate(() => {
          // Look for elements that might contain codes
          const allElements = document.querySelectorAll('*');
          for (const element of allElements) {
            const text = element.textContent || element.innerText || '';
            if (text && text.length >= 6 && text.length <= 12) {
              // Check if it looks like a code (alphanumeric)
              if (/^[A-Za-z0-9]+$/.test(text.trim())) {
                return text.trim();
              }
            }
          }
          return null;
        });
      }
    ];

    for (const strategy of extractionStrategies) {
      try {
        const code = await strategy();
        if (code && code.length >= 6) {
          log(`Code extracted using strategy: ${strategy.name}`);
          return code;
        }
      } catch (e) {
        log('Extraction strategy failed:', e.message);
        continue;
      }
    }

    return null;
  }

  /**
   * Enhanced cleanup with error handling
   */
  async cleanup() {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      log('Enhanced browser cleanup completed');
    } catch (error) {
      log('Error during enhanced browser cleanup:', error.message);
    }
  }

  /**
   * Enhanced screenshot with metadata
   */
  async takeScreenshot(filename = 'debug-screenshot.png') {
    if (this.page) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fullFilename = `${timestamp}-${filename}`;
        
        await this.page.screenshot({ 
          path: fullFilename, 
          fullPage: true,
          quality: 90
        });
        
        log(`Enhanced screenshot saved: ${fullFilename}`);
        return fullFilename;
      } catch (error) {
        log('Failed to take enhanced screenshot:', error.message);
      }
    }
    return null;
  }
}

/**
 * Enhanced main function with better error handling and monitoring
 */
export async function generateDrmCodeWithBrowser(appId, credentials, confirmCode = null, options = {}) {
  const browser = new BrowserAutomation(options);
  const startTime = Date.now();
  
  try {
    await browser.init();
    
    // Login to Steam if needed
    await browser.steamLogin(credentials, confirmCode);
    
    // Generate DRM code
    const code = await browser.generateDrmCode(appId);
    
    const duration = Date.now() - startTime;
    log(`Browser automation completed successfully in ${duration}ms`);
    
    return code;
  } catch (error) {
    const duration = Date.now() - startTime;
    log(`Browser automation failed after ${duration}ms: ${error.message}`);
    
    // Take final screenshot for debugging
    await browser.takeScreenshot('final-error.png');
    
    throw error;
  } finally {
    await browser.cleanup();
  }
}

export default BrowserAutomation;
