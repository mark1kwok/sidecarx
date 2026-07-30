/**
 * Debug Logging Module
 * Conditional logging that can be toggled via localStorage.
 * 
 * Enable:  localStorage.setItem('debug', 'true')
 * Disable: localStorage.removeItem('debug')
 */

const isDebug = () => localStorage.getItem('debug') === 'true';

export const debug = {
    log(...args) {
        if (isDebug()) console.log(...args);
    },
    warn(...args) {
        if (isDebug()) console.warn(...args);
    },
    /** Errors always log regardless of debug flag */
    error(...args) {
        console.error(...args);
    },
};
