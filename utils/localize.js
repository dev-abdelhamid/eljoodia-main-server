/**
 * Localizes the data based on the specified language and translatable fields.
 * @param {Object} data - The data object to localize (e.g., product, branch, user).
 * @param {string} lang - The language code ('ar' or 'en').
 * @param {string[]} translatableFields - Array of field names that may have translations (e.g., ['name', 'address', 'user.name']).
 * @returns {Object} - The localized data object.
 */
const localizeData = (data, lang = 'en', translatableFields = []) => {
  const langCode = lang === 'ar' ? 'ar' : 'en';
  const localizedData = { ...data.toObject ? data.toObject() : data };

  translatableFields.forEach((field) => {
    const fieldParts = field.split('.');
    let current = localizedData;

    // Navigate to the nested field
    for (let i = 0; i < fieldParts.length - 1; i++) {
      current = current[fieldParts[i]];
      if (!current) return;
    }
    const finalField = fieldParts[fieldParts.length - 1];

    if (current[finalField]) {
      if (typeof current[finalField] === 'string') {
        // For old data (single string), return as is
        current[finalField] = current[finalField];
      } else if (current[finalField][langCode]) {
        // For new data (object with ar/en), return the translated field
        current[finalField] = current[finalField][langCode];
      } else {
        // Fallback to the other language if the requested one is missing
        current[finalField] = current[finalField].ar || current[finalField].en || '';
      }
    }
  });

  return localizedData;
};

module.exports = { localizeData };