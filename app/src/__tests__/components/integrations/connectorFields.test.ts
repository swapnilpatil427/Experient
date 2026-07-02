import { describe, it, expect } from 'vitest';
import {
  CATEGORY_CONNECTORS, CONNECTOR_FIELDS, validateField, isValidUrl, isValidEmail,
  stripTrailingSlash, isFormValid,
} from '../../../components/integrations/connectorFields';

describe('connectorFields — CATEGORY_CONNECTORS', () => {
  it('lists exactly the 5 user-facing connectors, excluding webhook', () => {
    expect(CATEGORY_CONNECTORS).toEqual(['jira', 'salesforce', 'servicenow', 'zendesk', 'slack']);
  });
});

describe('connectorFields — CONNECTOR_FIELDS (David\'s exact vault keys)', () => {
  it('Jira requires baseUrl/email/apiToken/projectKey', () => {
    expect(CONNECTOR_FIELDS.jira.map((f) => f.key)).toEqual(['baseUrl', 'email', 'apiToken', 'projectKey']);
  });
  it('Salesforce requires instanceUrl/accessToken', () => {
    expect(CONNECTOR_FIELDS.salesforce.map((f) => f.key)).toEqual(['instanceUrl', 'accessToken']);
  });
  it('ServiceNow requires instanceUrl/user/password', () => {
    expect(CONNECTOR_FIELDS.servicenow.map((f) => f.key)).toEqual(['instanceUrl', 'user', 'password']);
  });
  it('Zendesk requires subdomain/email/apiToken', () => {
    expect(CONNECTOR_FIELDS.zendesk.map((f) => f.key)).toEqual(['subdomain', 'email', 'apiToken']);
  });
  it('Slack has exactly one field: webhook_url — no channel field', () => {
    expect(CONNECTOR_FIELDS.slack.map((f) => f.key)).toEqual(['webhook_url']);
  });
});

describe('connectorFields — isValidUrl / isValidEmail', () => {
  it('accepts a well-formed https URL', () => {
    expect(isValidUrl('https://acme.atlassian.net')).toBe(true);
  });
  it('rejects a bare domain with no scheme', () => {
    expect(isValidUrl('acme.atlassian.net')).toBe(false);
  });
  it('accepts a standard email', () => {
    expect(isValidEmail('me@acme.com')).toBe(true);
  });
  it('rejects a malformed email', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
  });
});

describe('connectorFields — validateField', () => {
  it('flags an empty required field', () => {
    expect(validateField('jira', 'baseUrl', '')).toBe('integrationsSettings.validation.required');
  });
  it('flags an invalid URL for baseUrl/instanceUrl', () => {
    expect(validateField('jira', 'baseUrl', 'not a url')).toBe('integrationsSettings.validation.invalidUrl');
    expect(validateField('salesforce', 'instanceUrl', 'not a url')).toBe('integrationsSettings.validation.invalidUrl');
  });
  it('flags an invalid email', () => {
    expect(validateField('jira', 'email', 'nope')).toBe('integrationsSettings.validation.invalidEmail');
  });
  it('flags a malformed Jira project key', () => {
    expect(validateField('jira', 'projectKey', '1lower')).toBe('integrationsSettings.validation.invalidProjectKey');
  });
  it('accepts a well-formed uppercase project key', () => {
    expect(validateField('jira', 'projectKey', 'ENG')).toBeNull();
  });
  it('rejects a Zendesk subdomain that looks like a full URL', () => {
    expect(validateField('zendesk', 'subdomain', 'https://acme.zendesk.com')).toBe('integrationsSettings.validation.invalidSubdomain');
  });
  it('accepts a bare Zendesk subdomain', () => {
    expect(validateField('zendesk', 'subdomain', 'acme')).toBeNull();
  });
  it('rejects a Slack URL that does not start with the hooks.slack.com prefix', () => {
    expect(validateField('slack', 'webhook_url', 'https://evil.example.com/hook')).toBe('integrationsSettings.validation.invalidSlackWebhook');
  });
  it('accepts a well-formed Slack webhook URL', () => {
    expect(validateField('slack', 'webhook_url', 'https://hooks.slack.com/services/T000/B000/XXXX')).toBeNull();
  });
});

describe('connectorFields — stripTrailingSlash', () => {
  it('removes exactly one trailing slash', () => {
    expect(stripTrailingSlash('https://acme.atlassian.net/')).toBe('https://acme.atlassian.net');
  });
  it('leaves a URL with no trailing slash unchanged', () => {
    expect(stripTrailingSlash('https://acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });
});

describe('connectorFields — isFormValid', () => {
  it('is false when a required field is missing', () => {
    expect(isFormValid('jira', { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', apiToken: 'tok', projectKey: '' })).toBe(false);
  });
  it('is true when all fields are present and valid', () => {
    expect(isFormValid('jira', { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com', apiToken: 'tok', projectKey: 'ENG' })).toBe(true);
  });
});
