// Force truecolor so UI tests can assert the Artemis palette (chalk reads this at import time).
// FORCE_COLOR alone is not enough: with a non-TTY stream and TERM=linux, chalk settles on
// basic 16-colour and the palette assertions see \x1b[32m instead of \x1b[38;2;61;190;120m.
// COLORTERM is what lifts it to truecolor, so both are set here.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM ??= "truecolor";
