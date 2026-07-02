import { useRef, useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { MessageBubble } from './MessageBubble';
import { InputArea } from './InputArea';
import { StreamingDots } from './StreamingDots';
import { useAppStore, generateId } from '../../lib/store';
import { Sparkles, PanelRightOpen, PanelRightClose, Database, MessageSquare, X } from 'lucide-react';
import { listConnectors } from '../../lib/connectors-api';
import { STARTUP_ACTIONS, STARTUP_FOLLOWUP, startupAssistantEnabled } from '../../lib/startup';

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function pickPreferredVoice(voices: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  const preferredNames = [
    'microsoft stefan',
    'microsoft conrad',
    'stefan',
    'conrad',
    'jonas',
    'lukas',
    'bernd',
    'falk',
  ];

  const normalizedLocale = locale.toLowerCase();
  const normalized = voices.map((voice) => ({
    voice,
    name: voice.name.toLowerCase(),
    lang: voice.lang.toLowerCase(),
  }));

  const exactLocaleMatch = normalized.find(({ lang, name }) => (
    lang === normalizedLocale && preferredNames.some((needle) => name.includes(needle))
  ));
  if (exactLocaleMatch) return exactLocaleMatch.voice;

  const localeMatch = normalized.find(({ lang, name }) => (
    lang.startsWith(normalizedLocale.split('-')[0]) && preferredNames.some((needle) => name.includes(needle))
  ));
  if (localeMatch) return localeMatch.voice;

  const anyMaleNamed = normalized.find(({ lang, name }) =>
    lang.startsWith('de') &&
    preferredNames.some((needle) => name.includes(needle))
  );
  if (anyMaleNamed) return anyMaleNamed.voice;

  const germanFallback = normalized.find(({ lang }) => lang.startsWith('de'));
  if (germanFallback) return germanFallback.voice;

  const anyLocale = normalized.find(({ lang }) => lang.startsWith(normalizedLocale.split('-')[0]));
  if (anyLocale) return anyLocale.voice;

  return voices[0] ?? null;
}

function resolveSpeechVoice(
  voices: SpeechSynthesisVoice[],
  preferredName: string,
  locale: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  const normalizedPreferred = preferredName.trim().toLowerCase();
  if (normalizedPreferred) {
    const exact = voices.find((voice) => voice.name.toLowerCase() === normalizedPreferred);
    if (exact) return exact;

    const contains = voices.find((voice) => voice.name.toLowerCase().includes(normalizedPreferred));
    if (contains) return contains;
  }

  return pickPreferredVoice(voices, locale);
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

function getWakeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Guten Morgen. Ich hoere zu.';
  if (hour < 18) return 'Guten Tag. Ich hoere zu.';
  return 'Guten Abend. Ich hoere zu.';
}

export function ChatArea() {
  const messages = useAppStore((s) => s.messages);
  const activeId = useAppStore((s) => s.activeId);
  const addMessage = useAppStore((s) => s.addMessage);
  const createConversation = useAppStore((s) => s.createConversation);
  const streamState = useAppStore((s) => s.streamState);
  const speechEnabled = useAppStore((s) => s.settings.speechEnabled);
  const voiceDialogEnabled = useAppStore((s) => s.settings.voiceDialogEnabled);
  const voiceReadAloudEnabled = useAppStore((s) => s.settings.voiceReadAloudEnabled);
  const speechVoiceName = useAppStore((s) => s.settings.speechVoiceName);
  const systemPanelOpen = useAppStore((s) => s.systemPanelOpen);
  const toggleSystemPanel = useAppStore((s) => s.toggleSystemPanel);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const wakeCooldownRef = useRef(0);
  const armedForFollowupRef = useRef(false);
  const wakeGreetingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followupDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followupTranscriptBufferRef = useRef('');
  const speakingRef = useRef(false);
  const lastSpokenAssistantIdRef = useRef('');
  const speechVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Check if any data sources are connected
  const [hasConnectedSources, setHasConnectedSources] = useState<boolean | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const conciergeEnabled = startupAssistantEnabled();

  useEffect(() => {
    listConnectors()
      .then((list) => setHasConnectedSources(list.some((c) => c.connected)))
      .catch(() => setHasConnectedSources(null));
  }, []);

  useEffect(() => {
    if (!conciergeEnabled || streamState.isStreaming) return;
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('openjarvis-startup-greeted') === 'true') return;

    const convId = activeId || createConversation();
    if (!convId) return;

    addMessage(convId, {
      id: generateId(),
      role: 'assistant',
      content: `${getGreeting()}! ${STARTUP_FOLLOWUP}`,
      timestamp: Date.now(),
    });
    sessionStorage.setItem('openjarvis-startup-greeted', 'true');
  }, [
    conciergeEnabled,
    streamState.isStreaming,
    activeId,
    createConversation,
    addMessage,
  ]);

  useEffect(() => {
    if (shouldAutoScroll.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streamState.content]);

  useEffect(() => {
    if (!voiceReadAloudEnabled) return;
    if (streamState.isStreaming) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant' || !lastMessage.content.trim()) return;
    if (lastMessage.id === lastSpokenAssistantIdRef.current) return;
    if (lastMessage.audio?.url) return;

    lastSpokenAssistantIdRef.current = lastMessage.id;

    if ('speechSynthesis' in window) {
      const voices = window.speechSynthesis.getVoices();
      speechVoiceRef.current = resolveSpeechVoice(voices, speechVoiceName, 'de-DE');
      const utterance = new SpeechSynthesisUtterance(lastMessage.content);
      utterance.lang = 'de-DE';
      utterance.voice = speechVoiceRef.current;
      utterance.pitch = 0.9;
      utterance.rate = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }
  }, [messages, streamState.isStreaming, voiceReadAloudEnabled, speechVoiceName]);

  useEffect(() => {
    if (!speechEnabled || !voiceDialogEnabled) return;
    if (typeof window === 'undefined') return;

    const ctor = (
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    ) as BrowserSpeechRecognitionCtor | undefined;

    if (!ctor) return;

    const refreshVoiceSelection = () => {
      if (!('speechSynthesis' in window)) return;
      const voices = window.speechSynthesis.getVoices();
      speechVoiceRef.current = resolveSpeechVoice(voices, speechVoiceName, 'de-DE');
    };

    refreshVoiceSelection();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoiceSelection);

    const clearWakeGreetingTimer = () => {
      if (wakeGreetingTimerRef.current) {
        clearTimeout(wakeGreetingTimerRef.current);
        wakeGreetingTimerRef.current = null;
      }
    };

    const clearFollowupDispatchTimer = () => {
      if (followupDispatchTimerRef.current) {
        clearTimeout(followupDispatchTimerRef.current);
        followupDispatchTimerRef.current = null;
      }
    };

    const resetFollowupBuffer = () => {
      followupTranscriptBufferRef.current = '';
      clearFollowupDispatchTimer();
    };

    const scheduleFollowupDispatch = () => {
      clearFollowupDispatchTimer();
      followupDispatchTimerRef.current = setTimeout(() => {
        const buffered = followupTranscriptBufferRef.current.trim();
        if (!buffered) return;
        followupTranscriptBufferRef.current = '';
        armedForFollowupRef.current = false;
        const cleaned = buffered.replace(/\bjarvis\b[,\s]*/gi, '').trim();
        window.dispatchEvent(
          new CustomEvent('openjarvis-voice-command', {
            detail: cleaned || buffered,
          })
        );
      }, 700);
    };

    const speakWakeGreeting = () => {
      if (!('speechSynthesis' in window)) return;
      speakingRef.current = true;
      const voices = window.speechSynthesis.getVoices();
      speechVoiceRef.current = resolveSpeechVoice(voices, speechVoiceName, 'de-DE');
      const utterance = new SpeechSynthesisUtterance(getWakeGreeting());
      utterance.lang = 'de-DE';
      utterance.voice = speechVoiceRef.current;
      utterance.pitch = 0.9;
      utterance.rate = 1;
      utterance.onend = () => {
        speakingRef.current = false;
      };
      utterance.onerror = () => {
        speakingRef.current = false;
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    };

    let stopped = false;
    const recognition = new ctor();
    recognition.lang = 'de-DE';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      if (speakingRef.current) return;

      const startIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
      const finalChunks: string[] = [];

      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        const chunk = String(result?.[0]?.transcript || '').trim();
        if (chunk) finalChunks.push(chunk);
      }

      const transcript = finalChunks.join(' ').trim();
      if (!transcript) return;

      const lower = transcript.toLowerCase();

      if (armedForFollowupRef.current && transcript) {
        followupTranscriptBufferRef.current = `${followupTranscriptBufferRef.current} ${transcript}`.trim();
        clearWakeGreetingTimer();
        scheduleFollowupDispatch();
        return;
      }

      if (!lower.includes('jarvis')) return;

      const command = transcript.replace(/\bjarvis\b[,\s]*/gi, '').trim();

      const now = Date.now();
      if (now - wakeCooldownRef.current < 8000) return;
      wakeCooldownRef.current = now;

      if (command) {
        clearWakeGreetingTimer();
        resetFollowupBuffer();
        window.dispatchEvent(new CustomEvent('openjarvis-voice-command', { detail: command }));
        return;
      }

      armedForFollowupRef.current = true;
      resetFollowupBuffer();
      clearWakeGreetingTimer();
      wakeGreetingTimerRef.current = setTimeout(() => {
        if (!armedForFollowupRef.current || stopped) return;
        armedForFollowupRef.current = false;
        speakWakeGreeting();
      }, 1400);
    };

    recognition.onerror = () => {
      // Ignore transient recognition errors (permissions, network, no-speech).
    };

    recognition.onend = () => {
      if (stopped) return;
      try {
        recognition.start();
      } catch {
        // Starting twice can throw while engine is already active.
      }
    };

    try {
      recognition.start();
    } catch {
      // Microphone permission might not be granted yet.
    }

    return () => {
      stopped = true;
      clearWakeGreetingTimer();
      clearFollowupDispatchTimer();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.removeEventListener('voiceschanged', refreshVoiceSelection);
      }
      try {
        recognition.stop();
      } catch {
        // Stop can throw if recognition did not start.
      }
    };
  }, [speechEnabled, voiceDialogEnabled, speechVoiceName]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 100;
  };

  const isEmpty = messages.length === 0 && !streamState.isStreaming;

  const PanelIcon = systemPanelOpen ? PanelRightClose : PanelRightOpen;

  const runStartupAction = useCallback((prompt: string) => {
    window.dispatchEvent(new CustomEvent('openjarvis-voice-command', { detail: prompt }));
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toggle bar */}
      <div className="flex items-center justify-end px-3 py-1.5 shrink-0">
        <button
          onClick={toggleSystemPanel}
          className="p-1.5 rounded-md transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-tertiary)' }}
          title={`${systemPanelOpen ? 'Hide' : 'Show'} system panel (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+I)`}
        >
          <PanelIcon size={16} />
        </button>
      </div>

      {/* Data sources banner */}
      {hasConnectedSources === false && !bannerDismissed && (
        <div
          className="mx-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-lg text-sm shrink-0"
          style={{
            background: 'var(--color-accent-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          <Database size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span style={{ color: 'var(--color-text-secondary)', flex: 1 }}>
            Connect your data sources (Gmail, iMessage, Slack, etc.) to get personalized answers.
          </span>
          <button
            onClick={() => navigate('/data-sources')}
            className="px-3 py-1 rounded text-xs font-medium cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)', border: 'none' }}
          >
            Connect
          </button>
          <button
            onClick={() => setBannerDismissed(true)}
            className="p-1 rounded cursor-pointer"
            style={{ color: 'var(--color-text-tertiary)', background: 'transparent', border: 'none' }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}
            >
              <Sparkles size={24} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
              {conciergeEnabled ? `${getGreeting()}!` : getGreeting()}
            </h2>
            <p className="text-sm text-center max-w-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
              {conciergeEnabled
                ? 'Was moechtest du heute machen? Ich kann sofort mit E-Mails, Nachrichten oder deinem Kalender starten.'
                : 'Ask anything. Your AI runs locally - private, fast, and always available.'}
            </p>

            {conciergeEnabled && (
              <div className="w-full max-w-xl grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                {STARTUP_ACTIONS.map((action) => (
                  <button
                    key={action.id}
                    onClick={() => runStartupAction(action.prompt)}
                    className="px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors"
                    style={{
                      background: 'var(--color-bg-secondary)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-secondary)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-accent)')}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}

            {/* Quick action hints */}
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/data-sources')}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
              >
                <Database size={14} style={{ color: 'var(--color-accent)' }} />
                Connect Data Sources
              </button>
              <button
                onClick={() => { navigate('/data-sources'); setTimeout(() => window.dispatchEvent(new CustomEvent('switch-tab', { detail: 'messaging' })), 100); }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs cursor-pointer transition-colors"
                style={{
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
              >
                <MessageSquare size={14} style={{ color: 'var(--color-accent)' }} />
                Set Up Messaging Channels
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[var(--chat-max-width)] mx-auto px-4 py-6">
            {messages.map((msg, i) => {
              const isLastAssistant =
                i === messages.length - 1 && msg.role === 'assistant';
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isLive={isLastAssistant && streamState.isStreaming}
                />
              );
            })}
            {(() => {
              if (!streamState.isStreaming || streamState.content !== '') return null;
              // For research messages the ResearchTimeline handles its own
              // pre-content loading state — suppress the generic dots.
              const last = messages[messages.length - 1];
              if (last?.role === 'assistant' && last.isResearch) return null;
              return (
                <div className="flex justify-start mb-4">
                  <StreamingDots phase={streamState.phase} />
                </div>
              );
            })()}
          </div>
        )}
      </div>
      <InputArea />
    </div>
  );
}
