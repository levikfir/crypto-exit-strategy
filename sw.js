// Service Worker for Crypto Exit Strategy PWA
const CACHE_NAME = 'crypto-exit-v1';
const ALERT_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// CoinGecko coin ID mapping
const COIN_IDS = {
  BTC: 'bitcoin', XRP: 'ripple', XLM: 'stellar', HBAR: 'hedera-hashgraph',
  ICP: 'internet-computer', XDC: 'xdce-crowd-sale', ALGO: 'algorand',
  IOTA: 'iota', AUDIO: 'audius', LINK: 'chainlink', AVAX: 'avalanche-2',
  VELO: 'velo', CASPER: 'casper-network', QUANT: 'quant-network',
  CC: 'cloudcoin', WALFI: 'walfi'
};

// Install event
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(clients.claim());
});

// Listen for messages from the main app
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  if (type === 'UPDATE_TARGETS') {
    // Store targets in IndexedDB-like cache
    self.alertTargets = data.targets || [];
    self.alertSettings = data.settings || { tiers: [{ pct: 10, label: 'approaching', color: 'yellow', enabled: true }], enabled: true };
    self.coinIds = data.coinIds || COIN_IDS;
    console.log('[SW] Updated targets:', self.alertTargets.length, 'targets, tiers:', (self.alertSettings.tiers || []).length);
  }

  if (type === 'CHECK_NOW') {
    checkPricesAndAlert();
  }
});

// Periodic sync (when supported)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-crypto-prices') {
    event.waitUntil(checkPricesAndAlert());
  }
});

// Push event (for future server-side push)
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Crypto Alert', {
      body: data.body || '',
      icon: 'pwa-icon-192.png',
      badge: 'pwa-icon-192.png',
      tag: data.tag || 'crypto-alert',
      data: data
    })
  );
});

// Notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // Focus existing window or open new one
      for (const client of clientList) {
        if (client.url.includes('crypto-exit-strategy') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('./crypto-exit-strategy.html');
    })
  );
});

// Main price checking function
async function checkPricesAndAlert() {
  if (!self.alertTargets || self.alertTargets.length === 0) return;
  if (!self.alertSettings || !self.alertSettings.enabled) return;

  const tiers = (self.alertSettings.tiers || []).filter(t => t.enabled).sort((a, b) => a.pct - b.pct);
  if (tiers.length === 0) return;
  const maxPct = Math.max(...tiers.map(t => t.pct));

  try {
    // Get unique coin IDs
    const symbols = [...new Set(self.alertTargets.map(t => t.symbol))];
    const ids = symbols.map(s => (self.coinIds || COIN_IDS)[s]).filter(Boolean);

    if (ids.length === 0) return;

    // Fetch current prices
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res = await fetch(url);
    if (!res.ok) return;
    const priceData = await res.json();

    // Build symbol -> price map
    const prices = {};
    symbols.forEach(symbol => {
      const id = (self.coinIds || COIN_IDS)[symbol];
      if (id && priceData[id]) {
        prices[symbol] = priceData[id].usd;
      }
    });

    // Check each target against tiers
    const alerts = [];
    const now = Date.now();

    // Track already-alerted targets per tier to avoid spam (reset every hour)
    if (!self.alertedTargets) self.alertedTargets = {};

    self.alertTargets.forEach(target => {
      const currentPrice = prices[target.symbol];
      if (!currentPrice || !target.targetPrice || target.targetPrice <= 0) return;

      const proximity = (currentPrice / target.targetPrice) * 100;
      if (proximity < (100 - maxPct) || proximity > 110) return;

      // Find the closest (most specific) tier
      let matchedTier = null;
      for (const tier of tiers) {
        if (proximity >= (100 - tier.pct) && proximity <= 110) {
          matchedTier = tier;
          break; // sorted by pct ascending, so first match is closest
        }
      }
      if (!matchedTier) return;

      const alertKey = `${target.symbol}-${target.targetPrice}-${target.type}-${matchedTier.pct}`;

      // Don't re-alert within 1 hour for same tier
      if (self.alertedTargets[alertKey] && (now - self.alertedTargets[alertKey]) < 3600000) return;

      self.alertedTargets[alertKey] = now;
      alerts.push({
        symbol: target.symbol,
        currentPrice,
        targetPrice: target.targetPrice,
        proximity: proximity.toFixed(1),
        level: target.level || '',
        type: target.type || 'exit',
        tierPct: matchedTier.pct,
        tierLabel: matchedTier.label,
        tierColor: matchedTier.color,
        direction: currentPrice >= target.targetPrice ? 'reached' : 'approaching'
      });
    });

    // Send notifications with tier-specific styling
    const urgencyIcons = { green: '\u{1F7E2}', yellow: '\u{1F7E1}', orange: '\u{1F7E0}', red: '\u{1F534}' };
    for (const alert of alerts) {
      const typeLabel = alert.type === 'vault' ? 'VAULT' : 'EXIT';
      const levelLabel = alert.level ? ` (${alert.level})` : '';
      const priceStr = alert.currentPrice < 1 ? alert.currentPrice.toFixed(6) : alert.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const targetStr = alert.targetPrice < 1 ? alert.targetPrice.toFixed(6) : alert.targetPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });
      const icon = urgencyIcons[alert.tierColor] || '';

      await self.registration.showNotification(
        `${icon} ${alert.symbol} ${alert.tierLabel} - ${typeLabel}${levelLabel}`,
        {
          body: `$${priceStr} / target: $${targetStr} (${alert.proximity}%)`,
          icon: 'pwa-icon-192.png',
          badge: 'pwa-icon-192.png',
          tag: `crypto-${alert.symbol}-${alert.type}-${alert.level}-${alert.tierPct}`,
          renotify: true,
          requireInteraction: alert.tierPct <= 0,
          vibrate: alert.tierPct <= 5 ? [200, 100, 200, 100, 200] : [200, 100, 200],
          data: { symbol: alert.symbol, tab: alert.type === 'vault' ? 'vault' : 'exitStrategy' }
        }
      );
    }

    // Notify main app about price update
    const allClients = await clients.matchAll();
    allClients.forEach(client => {
      client.postMessage({ type: 'PRICE_UPDATE', prices, alerts });
    });

    console.log('[SW] Price check done. Alerts:', alerts.length);
  } catch (err) {
    console.error('[SW] Price check error:', err);
  }
}
