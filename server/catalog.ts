/**
 * Static catalog shared with the browser (served at /api/catalog): languages the
 * translate model accepts, conversation scenarios, and voices.
 */

export interface Language {
  code: string;
  name: string;
  /** Native-script name shown next to the English one. */
  native: string;
  flag: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English", flag: "🇬🇧" },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸" },
  { code: "hi", name: "Hindi", native: "हिन्दी", flag: "🇮🇳" },
  { code: "fr", name: "French", native: "Français", flag: "🇫🇷" },
  { code: "de", name: "German", native: "Deutsch", flag: "🇩🇪" },
  { code: "pt-BR", name: "Portuguese (Brazil)", native: "Português", flag: "🇧🇷" },
  { code: "ja", name: "Japanese", native: "日本語", flag: "🇯🇵" },
  { code: "ko", name: "Korean", native: "한국어", flag: "🇰🇷" },
  { code: "zh-Hans", name: "Chinese (Simplified)", native: "中文", flag: "🇨🇳" },
  { code: "ar", name: "Arabic", native: "العربية", flag: "🇸🇦" },
  { code: "ru", name: "Russian", native: "Русский", flag: "🇷🇺" },
  { code: "pl", name: "Polish", native: "Polski", flag: "🇵🇱" },
  { code: "bn", name: "Bengali", native: "বাংলা", flag: "🇧🇩" },
  { code: "it", name: "Italian", native: "Italiano", flag: "🇮🇹" },
  { code: "nl", name: "Dutch", native: "Nederlands", flag: "🇳🇱" },
  { code: "tr", name: "Turkish", native: "Türkçe", flag: "🇹🇷" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", flag: "🇻🇳" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "ta", name: "Tamil", native: "தமிழ்", flag: "🇮🇳" },
  { code: "te", name: "Telugu", native: "తెలుగు", flag: "🇮🇳" },
  { code: "uk", name: "Ukrainian", native: "Українська", flag: "🇺🇦" },
  { code: "af", name: "Afrikaans", native: "Afrikaans", flag: "🇿🇦" },
  { code: "sq", name: "Albanian", native: "Shqip", flag: "🇦🇱" },
];

export type ScenarioId = "clinic" | "rental" | "support" | "travel" | "general";

export interface Scenario {
  id: ScenarioId;
  name: string;
  tagline: string;
  /** Who Person A and Person B typically are. */
  roleA: string;
  roleB: string;
  /** Guidance appended to the agent's system prompt. */
  agentHint: string;
  /** Persona used when the server plays Person B for a solo judge. */
  counterpartPersona: string;
  /** Scenario-specific fields the scribe extracts at the end. */
  fields: Array<{ key: string; label: string }>;
  /** Opening lines the counterpart may use (in English; translated before speaking). */
  openers: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "clinic",
    name: "Clinic visit",
    tagline: "Doctor and patient who do not share a language.",
    roleA: "Clinician",
    roleB: "Patient",
    agentHint:
      "Medical terms are the usual point of confusion: explain a term in one plain sentence when asked. Do not give diagnoses, dosages or medical judgement yourself; if asked, say in a few words that the clinician will answer that, without disclaimers.",
    counterpartPersona:
      "You are a worried patient who came in with a two-day headache, fever and nausea. You are cooperative but anxious, you take ibuprofen occasionally and you are allergic to penicillin.",
    fields: [
      { key: "chief_complaint", label: "Chief complaint" },
      { key: "symptoms_and_duration", label: "Symptoms and duration" },
      { key: "medications_and_allergies", label: "Medications and allergies" },
      { key: "plan", label: "Plan agreed" },
      { key: "follow_up", label: "Follow-up" },
    ],
    openers: [
      "Good morning doctor. Since yesterday my head hurts a lot and I have a fever.",
      "I also feel nauseous and I have not been able to eat much.",
      "Is it serious? I have never had a fever this high.",
    ],
  },
  {
    id: "rental",
    name: "Lease agreement",
    tagline: "Landlord and tenant negotiating terms.",
    roleA: "Landlord",
    roleB: "Tenant",
    agentHint:
      "Money, dates and deposits are where misunderstandings happen. When asked, restate an amount or date exactly as it was said, in the asker's language.",
    counterpartPersona:
      "You are a prospective tenant moving with a partner and a small dog. You want to move in on the first of next month, you ask about the deposit, utilities and whether pets are allowed, and you negotiate politely.",
    fields: [
      { key: "property_and_rent", label: "Property and rent" },
      { key: "deposit_and_fees", label: "Deposit and fees" },
      { key: "move_in_and_term", label: "Move-in date and term" },
      { key: "agreed_terms", label: "Terms agreed" },
      { key: "unresolved", label: "Still unresolved" },
    ],
    openers: [
      "Hello, thank you for showing me the apartment. When would it be available?",
      "How much is the deposit, and are utilities included in the rent?",
      "We have a small dog. Would that be a problem?",
    ],
  },
  {
    id: "support",
    name: "Customer support",
    tagline: "An agent helping a customer in another language.",
    roleA: "Support agent",
    roleB: "Customer",
    agentHint:
      "Product names, order numbers and error messages must be preserved exactly. Spell them out when asked.",
    counterpartPersona:
      "You are a customer whose new router drops the connection every evening. Order number 48-2210. You already restarted it twice. You are mildly frustrated but polite, and you want a replacement or a technician visit.",
    fields: [
      { key: "issue", label: "Issue reported" },
      { key: "identifiers", label: "Order / account identifiers" },
      { key: "steps_tried", label: "Steps already tried" },
      { key: "resolution", label: "Resolution offered" },
      { key: "commitments", label: "Commitments made" },
    ],
    openers: [
      "Hi, my new router keeps dropping the connection every evening. My order number is 48-2210.",
      "I already restarted it twice and updated the firmware. It still happens.",
      "Honestly I would prefer a replacement, or can someone come and check it?",
    ],
  },
  {
    id: "travel",
    name: "Travel desk",
    tagline: "Hotel, border or transit desk with a traveler.",
    roleA: "Desk staff",
    roleB: "Traveler",
    agentHint: "Dates, times, room numbers and document names are critical. Confirm them precisely when asked.",
    counterpartPersona:
      "You are a traveler arriving late at a hotel. Your booking seems to be under a misspelled name, you need a room for three nights, an early breakfast and a taxi to the airport on the last day.",
    fields: [
      { key: "request", label: "Traveler's request" },
      { key: "dates_and_times", label: "Dates and times" },
      { key: "documents_or_bookings", label: "Documents or bookings" },
      { key: "arrangements", label: "Arrangements made" },
      { key: "outstanding", label: "Outstanding items" },
    ],
    openers: [
      "Good evening. I have a booking for three nights but I think my name is misspelled.",
      "Could I get breakfast early, around six? My flight on Friday is at nine.",
      "And can you book a taxi to the airport for that morning?",
    ],
  },
  {
    id: "general",
    name: "General conversation",
    tagline: "Any two people, any topic.",
    roleA: "Person A",
    roleB: "Person B",
    agentHint: "The two people are talking to each other. When they say \"you\" they mean each other, never you: stay silent unless they say \"Parley\".",
    counterpartPersona: "You are a friendly person meeting Person A for the first time; you are curious about their work and city.",
    fields: [
      { key: "topics", label: "Topics discussed" },
      { key: "agreements", label: "Agreements" },
    ],
    openers: ["Hello! Nice to meet you. How has your day been so far?", "What kind of work do you do?"],
  },
];

export interface Voice {
  name: string;
  hint: string;
}

/** Prebuilt voices available to both the Live agent and the TTS models. */
export const VOICES: Voice[] = [
  { name: "Kore", hint: "firm, clear" },
  { name: "Aoede", hint: "breezy" },
  { name: "Leda", hint: "youthful" },
  { name: "Puck", hint: "upbeat" },
  { name: "Charon", hint: "informative" },
  { name: "Fenrir", hint: "excitable" },
  { name: "Orus", hint: "firm" },
  { name: "Zephyr", hint: "bright" },
];

export function findLanguage(code: string): Language | undefined {
  return LANGUAGES.find((language) => language.code === code);
}

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
