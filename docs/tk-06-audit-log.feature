Feature: Audit log of medical study access (TK-06)
  As an administrator
  I want an audit trail of every access to medical studies
  So that the system complies with medical-data privacy regulations

  Background:
    Given a user is authenticated with a valid access token

  Scenario Outline: Study access is logged automatically
    When the user performs a "<action>" on a study
    And the request succeeds
    Then an audit_log row is appended with the user, the action, the study id
      as resource, the current timestamp, and the caller's IP

    Examples:
      | action   |
      | VIEW     |
      | UPLOAD   |
      | DOWNLOAD |
      | DELETE   |

  Scenario: A failed or unauthorized access is not logged
    When the user performs a "VIEW" on a study
    And the request fails or is rejected (401/403/404)
    Then no audit_log row is appended for that request

  Scenario: The audit log is append-only, even for an admin
    Given at least one row already exists in audit_log
    When any database role attempts to UPDATE that row
    Then the database rejects the statement with an "append-only" error
    And the row is unchanged

  Scenario: The audit log cannot be deleted, even for an admin
    Given at least one row already exists in audit_log
    When any database role attempts to DELETE that row
    Then the database rejects the statement with an "append-only" error
    And the row still exists

  Scenario: An admin exports the audit log to CSV
    Given the authenticated user has the "admin" role
    When the admin requests GET /api/v1/activity/export
    Then the response is 200 with Content-Type "text/csv"
    And the response is an attachment named "audit-log.csv"
    And the CSV contains a header row and one line per audit_log entry

  Scenario Outline: Only an admin may export the audit log
    Given the authenticated user has the "<role>" role
    When the user requests GET /api/v1/activity/export
    Then the response is <status>

    Examples:
      | role          | status |
      | admin         | 200    |
      | medico        | 403    |
      | investigador  | 403    |

  Scenario: Each logged action is covered by a test
    Given the test suite in tests/integration/audit-log.integration.test.ts
    Then VIEW, UPLOAD, and DELETE each assert their own audit_log row
    And the append-only trigger is asserted directly against the database
    And the export endpoint's admin-only gate is asserted
