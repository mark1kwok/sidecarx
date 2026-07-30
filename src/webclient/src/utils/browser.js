/**
 * Browser engine detection helpers.
 */

/**
 * Detect WebKit-family browsers (Safari / iOS WebKit variants).
 * Excludes desktop Blink/Edge/Opera.
 * @returns {boolean}
 */
export function isWebKitBrowser() {
    const ua = navigator.userAgent || '';
    const isAppleWebKit = /AppleWebKit/i.test(ua);
    const isBlinkOrEdge = /(Chrome|Chromium|Edg|OPR)/i.test(ua) && !/(CriOS|FxiOS)/i.test(ua);
    return isAppleWebKit && !isBlinkOrEdge;
}
