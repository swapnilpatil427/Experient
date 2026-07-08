/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom" />

// Web Speech API types — not in lib.dom.d.ts by default in all TS versions
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionConstructor {
  new(): SpeechRecognitionInstance;
}
interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

// qrcode is an optional peer dep — declare a minimal shape so tsc doesn't fail before npm install
declare module 'qrcode' {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
  export function toCanvas(canvas: HTMLCanvasElement, text: string, options?: Record<string, unknown>): Promise<void>;
}

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
