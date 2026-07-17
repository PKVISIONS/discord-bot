/**
 * Detect whether a /leads question is a field search vs a file-name lookup.
 */

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseLeadsQuery(question) {
  const raw = String(question || '').trim();
  if (!raw) return { mode: 'empty', raw };

  const digits = digitsOnly(raw);

  if (digits.length === 9 && /^[\d\s]+$/.test(raw)) {
    return {
      mode: 'afm',
      raw,
      needle: digits,
      display: raw,
    };
  }

  if (digits.length >= 8 && /^[\d\s+\-().]+$/.test(raw)) {
    return {
      mode: 'phone',
      raw,
      needle: digits,
      display: raw,
    };
  }

  if (/@/.test(raw)) {
    return {
      mode: 'email',
      raw,
      needle: normalizeSearchText(raw),
      display: raw,
    };
  }

  const looksLikeFileQuestion = /ποιο|πού|που|αρχείο|αρχειο|excel|file|leads|περιέχει|περιεχει|which|where/i.test(raw);
  if (!looksLikeFileQuestion && raw.length <= 120) {
    return {
      mode: 'text',
      raw,
      needle: normalizeSearchText(raw),
      display: raw,
    };
  }

  return {
    mode: 'file',
    raw,
    needle: raw,
    display: raw,
  };
}

function cellToString(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function cellDigits(value) {
  return digitsOnly(cellToString(value));
}

function matchesPhoneCell(cellValue, needleDigits) {
  const cellDigitsValue = cellDigits(cellValue);
  if (!cellDigitsValue || !needleDigits) return false;
  if (cellDigitsValue === needleDigits) return true;
  if (cellDigitsValue.endsWith(needleDigits)) return true;
  if (needleDigits.endsWith(cellDigitsValue) && cellDigitsValue.length >= 8) return true;
  return false;
}

function matchesTextCell(cellValue, needle) {
  const hay = normalizeSearchText(cellToString(cellValue));
  if (!hay || !needle) return false;
  return hay.includes(needle);
}

function matchesCell(cellValue, query) {
  switch (query.mode) {
    case 'phone':
    case 'afm':
      return matchesPhoneCell(cellValue, query.needle);
    case 'email':
    case 'text':
      return matchesTextCell(cellValue, query.needle);
    default:
      return false;
  }
}

module.exports = {
  parseLeadsQuery,
  cellToString,
  matchesCell,
  digitsOnly,
};
