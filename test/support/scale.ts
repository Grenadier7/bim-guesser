// Vor allen Server-Imports laden: Rate-Limits für In-Prozess-Tests hochsetzen (SCALE wird beim Import gelesen)
process.env.RATE_LIMIT_SCALE ??= '1000';
