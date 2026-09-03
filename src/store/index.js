import { create } from 'zustand'

export const useAppStore = create((set, get) => ({
  view: 'idle', // 'idle' | 'edit' | 'read'
  setView: (view) => set({ view }),

  config: {
    mode: 'notch',
    scrollSpeed: 1,
    fontSize: 16,
    opacity: 1,
    threshold: 0.018,
    autoScroll: false,
    micDeviceId: 'default',
    theme: 'dark',
    wordTracking: true,
    trackingHints: '',
    aiProvider: '',
    aiModel: '',
    aiLocalUrl: 'http://localhost:11434',
  },
  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),

  // Speech-tracking state (written by ReadView while reading)
  recognition: {
    engine: 'none',        // 'none' | 'speech' (word tracking) | 'vad' (frequency fallback)
    status: 'idle',        // 'idle' | 'starting' | 'listening' | 'error'
    message: '',           // human-readable status/error for the UI
    cursorTokenIndex: -1,  // index into the token array of the next expected word
    matchedCount: 0,       // script words already spoken
    total: 0,              // total matchable script words
    confidence: 0,         // recognizer confidence of the latest result (0..1)
  },
  setRecognition: (patch) => set((s) => ({ recognition: { ...s.recognition, ...patch } })),

  scripts: [],
  currentScriptIndex: -1,
  setScripts: (scripts) => set({ scripts }),
  setCurrentScriptIndex: (i) => set({ currentScriptIndex: i }),

  scriptText: '',
  setScriptText: (text) => set({ scriptText: text }),
  scriptDoc: null,  // Tiptap JSON doc
  setScriptDoc: (doc) => set({ scriptDoc: doc }),

  isPaused: false,
  isHoverPaused: false,
  isSpeaking: false,
  isRunning: false,
  setIsPaused: (v) => set({ isPaused: v }),
  setIsHoverPaused: (v) => set({ isHoverPaused: v }),
  setIsSpeaking: (v) => set({ isSpeaking: v }),
  setIsRunning: (v) => set({ isRunning: v }),

  speedIndex: 3,
  setSpeedIndex: (i) => set({ speedIndex: i }),
}))
