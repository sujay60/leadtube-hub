/**
 * Template engine for personalized email variable interpolation.
 * Supports: {{variable}}, {{variable|default:"fallback"}}, {{#if variable}}...{{/if}}
 */

function renderTemplate(template, contact) {
  if (!template) return '';

  let customFields = {};
  try {
    customFields = typeof contact.custom_fields === 'string'
      ? JSON.parse(contact.custom_fields)
      : (contact.custom_fields || {});
  } catch (e) { customFields = {}; }

  // Build variable map from contact fields + custom fields
  const vars = {
    email: contact.email || '',
    firstName: contact.first_name || '',
    first_name: contact.first_name || '',
    lastName: contact.last_name || '',
    last_name: contact.last_name || '',
    channelName: contact.channel_name || '',
    channel_name: contact.channel_name || '',
    channelUrl: contact.channel_url || '',
    channel_url: contact.channel_url || '',
    subscriberCount: contact.subscriber_count || '',
    subscriber_count: contact.subscriber_count || '',
    niche: contact.niche || '',
    country: contact.country || '',
    language: contact.language || '',
    ...customFields
  };

  let result = template;

  // Handle {{#if variable}}content{{/if}}
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
    return vars[varName] ? content : '';
  });

  // Handle {{variable|default:"fallback"}}
  result = result.replace(/\{\{(\w+)\|default:"([^"]*)"\}\}/g, (match, varName, defaultVal) => {
    return vars[varName] || defaultVal;
  });

  // Handle {{variable}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return vars[varName] !== undefined ? vars[varName] : match;
  });

  return result;
}

/**
 * Inject open tracking pixel and wrap links for click tracking
 */
function injectTracking(html, trackingId, baseUrl) {
  // Add open tracking pixel before </body> or at end
  const pixel = `<img src="${baseUrl}/t/o/${trackingId}" width="1" height="1" style="display:none" alt="" />`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', pixel + '</body>');
  } else {
    html += pixel;
  }

  // Wrap <a href="..."> links for click tracking (skip mailto: and #)
  html = html.replace(/(<a\s[^>]*href=")([^"]+)(")/gi, (match, pre, url, post) => {
    if (url.startsWith('mailto:') || url.startsWith('#') || url.includes('/t/c/')) return match;
    const trackUrl = `${baseUrl}/t/c/${trackingId}?url=${encodeURIComponent(url)}`;
    return pre + trackUrl + post;
  });

  return html;
}

module.exports = { renderTemplate, injectTracking };
