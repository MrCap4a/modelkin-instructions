# Выкладка на сервер

GitHub Actions проверяет проект, собирает Docker-образ и пересылает его по SSH на сервер лендинга 3-dpoint.ru. Для выкладки нужны Ubuntu или Debian, Linux x86-64, Docker Compose v2.23 или новее, SSH на стандартном порту и общий контейнер Caddy.

## Настройка сервера один раз

1. Направьте DNS домена **моделкин.рф** на сервер. В конфигурации используется его ASCII-имя `xn--d1acjhedmc.xn--p1ai`. Порты 80 и 443 должны вести на общий Caddy.
2. На сервере создайте `~/modelkin-instruction/.env` под пользователем, которого будет использовать GitHub Actions. Пользователю нужен доступ к Docker. Задайте отдельные пароли для роли приложения и администратора PostgreSQL.

   ```bash
   install -d -m 700 ~/modelkin-instruction
   cd ~/modelkin-instruction
   (umask 077; set -o noclobber; printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env)
   ```

   Укажите в `.env` значение `PROXY_NETWORK` с именем существующей сети Caddy. Чтобы узнать имя, выполните `docker ps --format '{{.Names}} {{.Image}}'`, затем `docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' ИМЯ_КОНТЕЙНЕРА_CADDY`. В инфраструктурном репозитории лендинга сеть называется `caddy`, а её фактическое имя в Docker зависит от имени Compose-проекта. Например, для проекта `compose` это обычно `PROXY_NETWORK=compose_caddy`.

   PostgreSQL хранит данные в отдельном томе. Роль приложения владеет своей базой. Значение `POSTGRES_PASSWORD` должно быть пригодно для URI, как в примере. При смене пароля существующей базы обновите также пароль роли PostgreSQL.
3. Добавьте блок домена в Caddyfile через действующий порядок обновления инфраструктуры лендинга. Если домен уже обслуживается Caddy, учитывайте существующий блок при настройке маршрута.

   ```caddyfile
   xn--d1acjhedmc.xn--p1ai {
       reverse_proxy modelkin-instruction:8080 {
           header_up X-Modelkin-Client-IP {remote_host}
       }
   }
   ```

   Caddy перезаписывает заголовок IP для ограничения попыток входа. Контейнер приложения доступен в пределах Docker-сети и через Caddy, порты базы не опубликованы.
4. Добавьте публичную часть ключа выкладки в `authorized_keys` выбранного пользователя. Возьмите ключ хоста SSH из доверенного источника, например из консоли сервера. Секреты DxfMaker для этого проекта самостоятельно не копируются.

## GitHub

В репозитории, в **Settings → Secrets and variables → Actions**, создайте:

- **Secret** `SERVER_SSH_KEY` с приватным ключом выкладки.
- **Variable** `SERVER_HOST` с именем или IPv4-адресом сервера.
- **Variable** `SERVER_USER` с именем SSH-пользователя.
- **Variable** `SERVER_HOST_KEY` с полной строкой формата `SERVER_HOST ssh-ed25519 AAAA…` для `known_hosts`.
- Необязательная **Variable** `SITE_DOMAIN` переопределяет домен. По умолчанию используется `моделкин.рф`. Для другого кириллического домена укажите ASCII-имя (Punycode).

Для первой выкладки создайте на GitHub пустой репозиторий без README и лицензии. Настройте сервер и параметры Actions до первого push. В локальной ветке `main` подключите репозиторий и отправьте коммит:

```bash
git remote add origin 'https://github.com/OWNER/REPOSITORY.git'
git push -u origin main
```

Если вы начали с ZIP исходников, сначала выполните `git init -b main`, `git add .` и `git commit -m "Initial release"`.

В разделе **Actions → Instructions** видны три этапа. `test` собирает редактор и запускает тесты с PostgreSQL. `image` собирает Linux-образ, поднимает его с чистой базой, проверяет версию и файлы редактора. Для push в `main` и ручного запуска на этой ветке `deploy` передаёт проверенный образ по SSH, запускает его на сервере и проверяет версию через публичный HTTPS. Для pull request выполняются первые два этапа.

## Первый вход и импорт

После первой успешной выкладки подключитесь к серверу. Для команд обслуживания создайте функцию в текущей оболочке:

```bash
cd ~/modelkin-instruction
modelkin() {
    docker compose --project-directory "$PWD" --env-file .env \
        --env-file current/release.env -f current/compose.yml "$@"
}
```

Если есть старая SQLite, выполните импорт **до создания новой учётной записи или редактирования**. Скопируйте закрытую, согласованную копию SQLite на сервер, например в `~/modelkin-instruction/legacy.sqlite3`. Команда ниже передаёт копию в одноразовый контейнер через временный том Docker, чтобы контейнер с непривилегированным пользователем мог прочитать файл, а файл в домашнем каталоге сохранил приватные права:

```bash
docker volume create modelkin-instruction-import
modelkin run --rm --no-deps -T --user 0 --entrypoint sh \
    -v modelkin-instruction-import:/import app \
    -c 'umask 077; cat > /import/legacy.sqlite3; chown 10001:10001 /import/legacy.sqlite3' \
    < legacy.sqlite3
modelkin run --rm --no-deps \
    -v modelkin-instruction-import:/import:ro app import-sqlite /import/legacy.sqlite3
docker volume rm modelkin-instruction-import
```

Если переносить данные не нужно, выполните `modelkin exec app modelkin-instruction admin`. В дальнейшем той же командой можно сменить пароль.

## Проверка и восстановление

`/healthz` проверяет соединение с базой и отдаёт хеш запущенной версии. Если новая версия не проходит проверку, скрипт возвращает прежний образ и конфигурацию. База остаётся в постоянном томе. Миграции выполняются при запуске и при откате образа не отменяются, поэтому обновления схемы должны оставаться совместимыми с предыдущей версией на время выкладки.

Для резервной копии используйте `modelkin exec -T db pg_dump -U modelkin -Fc modelkin > modelkin.dump`. Дамп включает тексты, картинки, ссылки и учётную запись. Храните копию отдельно от сервера и проверяйте восстановление в отдельной базе через `pg_restore`.
