import { createContext } from "react";

/**
 * THE DECLARED-VALUE HOLD OF A GATE'S CONTINUE (cinatra#4244, design
 * app-lifecycle-cards.html section V.1, "A declared value holds the Continue").
 *
 * A host that mounts a mid-run gate whose fields the schema-field fallback
 * draws, and lets the drawn field own the gate's one Continue, provides `true`.
 * The structured object field then draws that Continue UNAVAILABLE until every
 * declared-required value of a kind it reads as typed (text, number, list,
 * choice) is written - text blank once trimmed and an empty list are not
 * written - and adds no sentence of its own for the hold. Everywhere else (a
 * setup field, a grouped setup form, any host that provides nothing) the
 * default `false` keeps the field exactly as it was.
 */
export const GateContinueHoldContext = createContext<boolean>(false);
