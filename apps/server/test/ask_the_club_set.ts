// A small labelled set for ask the club: eight facts a padel club might write, and questions with the answer a
// person at the desk would give (one of the facts, or "staff"). The live check (ask_the_club_live.ts) runs it
// through the real models; change the questions or thresholds in answerer.ts and run it again.
import type { AnswerCandidate } from "@kumi/core";

type Two = { en: { question: string; answer: string }; es: { question: string; answer: string } };
export const SET_FACTS: (Two & { id: string; topic: string })[] = [
  { id: "00000000-0000-7000-8000-00000000a001", topic: "hours",
    en: { question: "When are you open?", answer: "Every day from 7 AM to 11 PM. On public holidays, 8 AM to 6 PM." },
    es: { question: "¿Cuándo abren?", answer: "Todos los días de 7 a. m. a 11 p. m. Los días festivos, de 8 a. m. a 6 p. m." } },
  { id: "00000000-0000-7000-8000-00000000a002", topic: "parking",
    en: { question: "Where do I park?", answer: "Free parking in the lot behind the club. After 6 PM, there's overflow parking on Elm Street." },
    es: { question: "¿Dónde estaciono?", answer: "Estacionamiento gratis detrás del club. Después de las 6 p. m., hay más lugar en la calle Elm." } },
  { id: "00000000-0000-7000-8000-00000000a003", topic: "prices",
    en: { question: "Can I bring a guest?", answer: "Yes. A guest pays $15 a visit and signs the waiver at the front desk. Members can bring up to 3 guests a month." },
    es: { question: "¿Puedo traer un invitado?", answer: "Sí. Un invitado paga $15 por visita y firma la exención en recepción. Los socios pueden traer hasta 3 invitados al mes." } },
  { id: "00000000-0000-7000-8000-00000000a004", topic: "bookings",
    en: { question: "What's the cancellation rule for court bookings?", answer: "Cancel at least 24 hours before your booking for a full refund. Later than that, there's no refund unless someone takes your place." },
    es: { question: "¿Cuál es la regla para cancelar una reserva de pista?", answer: "Cancela al menos 24 horas antes para un reembolso completo. Después, no hay reembolso salvo que alguien tome tu lugar." } },
  { id: "00000000-0000-7000-8000-00000000a005", topic: "facilities",
    en: { question: "Can I rent a racket?", answer: "Yes, rackets are $5 to rent at the front desk, and a can of balls is $6." },
    es: { question: "¿Puedo alquilar una pala?", answer: "Sí, alquilar una pala cuesta $5 en recepción, y un tubo de pelotas cuesta $6." } },
  { id: "00000000-0000-7000-8000-00000000a006", topic: "juniors",
    en: { question: "From what age can kids play?", answer: "Juniors from 6 to 17 can join our junior programs. Under 12s need an adult at the club." },
    es: { question: "¿Desde qué edad pueden jugar los niños?", answer: "Los juniors de 6 a 17 años pueden unirse a los programas juveniles. Los menores de 12 necesitan un adulto en el club." } },
  { id: "00000000-0000-7000-8000-00000000a007", topic: "facilities",
    en: { question: "Do you have lockers?", answer: "Day lockers are free; bring your own padlock. Monthly lockers are $20 a month at the front desk." },
    es: { question: "¿Tienen casilleros?", answer: "Los casilleros por día son gratis; trae tu propio candado. Los mensuales cuestan $20 al mes en recepción." } },
  { id: "00000000-0000-7000-8000-00000000a008", topic: "rules",
    en: { question: "Is there a dress code?", answer: "Clean non-marking court shoes are required. Running shoes with black soles aren't allowed on court." },
    es: { question: "¿Hay código de vestimenta?", answer: "Se requieren zapatillas de pista limpias que no marquen. No se permiten zapatillas de correr con suela negra en la pista." } },
];
const id = (topicKey: number) => SET_FACTS[topicKey - 1]!.id;
/** What a person at the desk would do: send that fact, or answer it themselves. */
export const SET_QUESTIONS: { text: string; lang: "en" | "es"; want: string | "staff" }[] = [
  { text: "What time do you close on Saturday?", lang: "en", want: id(1) },
  { text: "Are you open on Thanksgiving?", lang: "en", want: id(1) },
  { text: "Is parking free?", lang: "en", want: id(2) },
  { text: "Where can I leave my car if the lot is full in the evening?", lang: "en", want: id(2) },
  { text: "How much does it cost to bring a friend?", lang: "en", want: id(3) },
  { text: "If I cancel 2 hours before, do I get my money back?", lang: "en", want: id(4) },
  { text: "Do you rent paddles?", lang: "en", want: id(5) },
  { text: "My daughter is 8, can she play?", lang: "en", want: id(6) },
  { text: "Is there somewhere to keep my bag while I play?", lang: "en", want: id(7) },
  { text: "Can I wear running shoes on court?", lang: "en", want: id(8) },
  { text: "Do you have showers?", lang: "en", want: "staff" },
  { text: "Can I book all the courts for my company's team event in March?", lang: "en", want: "staff" },
  { text: "Why was I charged twice for my booking yesterday?", lang: "en", want: "staff" },
  { text: "Can you move my 6pm booking tomorrow to 7pm?", lang: "en", want: "staff" },
  { text: "I hurt my wrist last night, can I pause my membership?", lang: "en", want: "staff" },
  { text: "The lights on court 3 weren't working tonight, very disappointing.", lang: "en", want: "staff" },
  { text: "What level am I?", lang: "en", want: "staff" },
  { text: "Can I get a refund for the clinic I missed on Tuesday?", lang: "en", want: "staff" },
  { text: "I cancelled my court 3 days ago but I still haven't got my refund", lang: "en", want: "staff" },
  { text: "¿A qué hora abren los domingos?", lang: "es", want: id(1) },
  { text: "¿Cuánto cuesta alquilar una pala?", lang: "es", want: id(5) },
  { text: "Me cobraron dos veces, ¿me pueden ayudar?", lang: "es", want: "staff" },
];
/** The facts as the answerer is given them, in the question's language. */
export const factsIn = (lang: "en" | "es"): AnswerCandidate[] => SET_FACTS.map((f) => ({ id: f.id, topic: f.topic, ...f[lang] }));
