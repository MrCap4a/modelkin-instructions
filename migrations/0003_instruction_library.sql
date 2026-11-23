ALTER TABLE releases DROP CONSTRAINT releases_draft_id_fkey,
    ADD FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE;
ALTER TABLE links DROP CONSTRAINT links_release_id_fkey,
    ADD FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE;

UPDATE levels AS l SET color = p.new_color
FROM (VALUES (1, 'Легко', '#24775a', '#30b383'),
             (2, 'Средне', '#975900', '#e3a319'),
             (3, 'Сложно', '#9c3e59', '#e46142')) AS p(id, name, old_color, new_color)
WHERE l.id = p.id AND l.name = p.name AND lower(l.color) = p.old_color AND NOT l.archived;
