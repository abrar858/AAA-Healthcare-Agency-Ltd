WITH requested(name) AS (VALUES ('Preston'), ('Blackburn'), ('Blackpool'))
UPDATE aaa_workspace
SET body = json_set(body, '$.branches', json((
  SELECT json_group_array(name)
  FROM (
    SELECT value AS name FROM json_each(aaa_workspace.body, '$.branches')
    UNION ALL
    SELECT name FROM requested
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(aaa_workspace.body, '$.branches') WHERE lower(value) = lower(name)
    )
  )
))), rev = rev + 1
WHERE id = 1 AND EXISTS (
  SELECT 1 FROM requested WHERE NOT EXISTS (
    SELECT 1 FROM json_each(aaa_workspace.body, '$.branches') WHERE lower(value) = lower(name)
  )
);
