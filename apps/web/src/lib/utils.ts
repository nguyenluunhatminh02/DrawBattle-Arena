import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let fallbackIdCounter = 0;

/** crypto.randomUUID is unavailable in insecure contexts (HTTP LAN). */
export function createStrokeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  const random = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
    ? Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16).padStart(8, '0')).join('')
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `stroke-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}-${random}`;
}
