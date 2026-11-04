# Проверка на констатациите от Sentry

Дата: 2026-10-27. Run: `run_01M5YMA9B8T5581M67PTBCA8Q8`.
Проверен текущ код: `dev` / `f47f527906a97f42290a58bc1ebdf58e13372209`.
Експортът съдържа 12 констатации от три успешно приключили агента.

Обследваната ревизия е `rev_01M5Y7MKMA1GQMNJAHJZF0VD61`, импортирана
на 27 октомври в 10:29 София. Изпълнението използва тази запазена ревизия,
а не автоматично последния код от Git. Това обяснява защо докладва и вече
поправен unit тест. Данните и командите в експорта не са изпълнявани като
инструкции; проверките по-долу използват отделни безопасни fixtures и реални
функции от проекта. Не е стартиран нов run или заявка към модел.

## Оценка на всичките 12 констатации

| №   | Констатация                                                       | Оценка за текущия код                                                                                                                                                                                                                                                                                                                               | Класификация                                                                          |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Избор на текущ merge result при еднаква версия и различни digests | Потвърдено противоречие между договора и кода. Избира лексикографски най-малкия digest, вместо да сигнализира двусмислие. Не е доказано, че такъв конфликт вече съществува в реалните данни.                                                                                                                                                        | Important: условен логически дефект / неясен договор                                  |
| 2   | Реален newline преминава през shell-syntax gate                   | Потвърден дефект в parser/replay поведението. Реален newline остава в argv; literal `\\n` се отхвърля. Това не стартира втора shell команда и не доказва sandbox escape.                                                                                                                                                                            | Important, с ниско непосредствено въздействие                                         |
| 3   | Липсва redaction за Authorization/Cookie                          | Потвърден пропуск за стойности, които не са в списъка с известни secrets. Проверени са authorization assignment, Basic header и cookie assignment. Известните стойности се заличават независимо от формата.                                                                                                                                         | Important: защитен пропуск; реално изтичане в този run не е установено                |
| 4   | Недостижим executable branch и `.ds_store` case                   | Предимно maintainability/policy наблюдение. Основният caller подава basename, но самата export-ната `resolveExecutable` поддържа директен absolute path на Linux. Finder файлът е `.DS_Store`; различното поведение за `.ds_store` не доказва нарушен договор.                                                                                      | Minor; не е потвърден функционален дефект от описания сценарий                        |
| 5   | Два едновременно активни runtime lease-а                          | Невярна предпоставка за предназначението на lease-а. Той следи живост/собственост; проектният lock е отделен и транзакционен. Две runtime инстанции са изрично предвидени в тест за foreign cancellation.                                                                                                                                           | Отхвърлено като дефект                                                                |
| 6   | `WorkspaceFactory.create()` трие без containment check            | Разликата спрямо `cleanup()` е реална. Проверено е само изчисляването на опасен път при изкуствено подадени невалидни IDs; не е извършвано изтриване. Текущият production caller използва вътрешно генерирани IDs. Не е доказан достижим външен път за загуба на данни.                                                                             | Minor: защитно укрепване, не текущ доказан destructive exploit                        |
| 7   | Fallback timeout от 2 секунди                                     | Константата съществува, но единственият текущ път към worker-а създава run с попълнен timeout. Не е възпроизведено нормално изпълнение, което да ползва fallback-а.                                                                                                                                                                                 | Minor: латентен риск / hardening                                                      |
| 8   | Redaction heuristics и минимална дължина                          | Частично вярно и се припокрива с №3. Desktop helper не заличава конфигурирана стойност от 7 символа; заличава 9-символна. Реалните provider credentials обичайно са по-дълги, а harness helper покрива известни стойности от 4 символа. Произволен неизвестен низ без маркер не може надеждно да се разпознае като secret.                          | Minor: конкретен threshold gap; общото твърдение за изтичане е прекалено широко       |
| 9   | Празни lock/env файлове са комитнати                              | Невярно за Git репото. Файловете присъстват локално/в snapshot-а, но `git ls-files` не ги съдържа. Lock/config stub файловете са в `.git/info/exclude`, а `.env*` са ignored.                                                                                                                                                                       | Отхвърлено твърдение за committed файлове; шум в QA копието е отделен въпрос          |
| 10  | Hygiene check не работи без `.git`                                | Поведението е потвърдено, но проверката по предназначение изисква tracked-file inventory. В нормалното repo минава; в отделен metadata-less fixture отказва. CI я изпълнява след Git checkout. Не следва да се превръща автоматично в PASS/skip за заобикаляне на gate-а.                                                                           | Ограничение на средата, не потвърден продуктов дефект                                 |
| 11  | Snapshot съдържа `.tsbuildinfo`, но изключва `dist`               | Потвърден актуален дефект в подготовката на QA копието. Manifest-ът съдържа incremental caches, а import matcher изключва `dist`, но запазва `.tsbuildinfo`. Реалният TypeScript build възпроизвежда успешен exit без необходимите outputs. Release/deploy pipeline изключва тези caches отделно, затова това не доказва счупен публикуван release. | Important; по-точно medium за QA import/build, а не доказан high production outage    |
| 12  | WSL parity и real-sandbox trust тестове                           | Смесени случаи. Старият parity fixture действително е зависел от host preflight; вече е заменен с hermetic release-prompt fixture и минава на WSL. Trust suite умишлено изисква истински sandbox; липсващата възможност трябва да се отчита, а не да се mock-ва като успешна security проверка. CI вече има отделна capability lane.                | Частично вярно за старата ревизия и вече поправено; останалото е изискване на средата |

## Доказателства и практически ефект

### 1. Merge selection

`packages/merger/src/cluster.ts:75` описва disambiguation, докато comparator-ът
на ред 92 избира по digest. Изпълних `selectCurrentMergeResult` с два валидни
64-символни SHA-256 digests и еднаква поддържана версия 3: винаги избра `a…`,
независимо от реда на входа. `apps/runtime/src/runtime.ts:811` подава всички
записани merge results и използва избрания ID в snapshot-а. Нужен е изричен
договор за конфликта; не е доказано повредено текущо потребителско изпълнение.

### 2. Newline parser

В `packages/verifier/src/runner.ts:39` regex-ът използва literal backslash-n.
Реалната `splitArgv('node check.mjs\nnode second.mjs')` върна аргументи с
newline в името на първия script. През истинската `VerificationCommandRunner`
и fake execution backend същите грешни аргументи стигнаха до backend-а.
Не се стартира shell или вторият `node`. Въздействието е некоректен replay
или диагностика, а не демонстрирано изпълнение на host escape команда.

### 3 и 8. Redaction

Използвах реалната `redactText` с изцяло синтетични стойности. Неизвестни
`authorization=…`, `Authorization: Basic …` и `cookie=…` стойности останаха
видими; същата cookie стойност, подадена като известен secret, беше заличена.
Шаблонът е в `packages/harness-opencode/src/redaction.ts:2`; Claude helper-ът
има същия шаблон. Отделно реалната `ProviderCredentialService` заличи
9-символен fake credential, но остави 7-символен. Fixture-ът не зарежда
потребителския credential store и не отпечатва реални secrets.

### 5–7. Ownership и защитни проверки

`RuntimeInstanceLease.start()` допуска два fresh lease-а, което възпроизведох
с временна база. Това е предвидено: `packages/run-engine/tests/closure.test.ts`
създава втори runtime, който иска cancellation от първия и няма право да
терминализира чуждо изпълнение. Този реален тест мина. Проектният lock се
поставя в transaction в `packages/project-manager/src/index.ts:555`.

За №6 проверката беше само върху изчисляване на път, без destructive действие.
За №7 проследих `RunCoordinator.run()` → създаване на configuration → worker:
timeout-ът се задава на ред 340 преди достигане на fallback-а на ред 743.

### 9–10. Git и snapshot среда

`git ls-files -- package-lock.json yarn.lock bunfig.toml .gitmodules .npmrc
.yarnrc .yarnrc.yml '.env*'` върна празен списък. `git check-ignore -v`
показа причините за игнориране. Manifest-ът на обследвания snapshot действително
включва празни локални stubs; от това не следва, че са committed.

Hygiene gate беше изпълнен и от истински временен каталог извън Git checkout:
exit 1 / `Repository hygiene check could not inspect tracked files.`
В текущото repo `pnpm repository:check` мина. Това е проверка на tracked files,
а не независим архивен валидатор.

### 11. TypeScript cache

Създадох отделно временно копие на реалния `@qa/shared` source и tsconfig,
използвах инсталирания TypeScript и изпълних последователно:

1. Build с `tsc -p ... --listEmittedFiles`: exit 0, създава `dist` и cache.
2. Премахване само на fixture `dist`, запазвайки `tsconfig.tsbuildinfo`.
3. Същият build: exit 0, **0 emitted files, 0 output files**.
4. Премахване на fixture cache и повторен build: exit 0, **24 output files**.

Всички изтривания са само в собствения временен fixture; реалните outputs,
данни и source на потребителя са запазени. Matcher-ът връща false за
`packages/shared/tsconfig.tsbuildinfo`, true за `packages/shared/dist/index.js`.
Snapshot manifest-ът доказва, че това съчетание е било внесено в реалния run.
Не съм повтарял целия `pnpm test` в копие на монорепото; минималният build
възпроизвежда конкретната причина. `apps/runtime/scripts/deploy-inner.sh:47`
вече изключва `*.tsbuildinfo` при deployment, което ограничава обхвата.

## Изпълнени проверки

- Merger suite: 29 PASS.
- Import exclusion suite: 5 PASS.
- Cross-runtime cancellation test: 1 PASS; останалите 6 не са избирани.
- Verifier shell/preflight test: 1 PASS; останалите 17 не са избирани.
- GLM release-prompt fixture на WSL: 1 PASS.
- Repository hygiene в текущото repo: PASS.
- Самостоятелни probes през production functions и реален TypeScript,
  описани по-горе; всички са в disposable fixtures или са pure calls.

Преминалите съществуващи тестове не опровергават липсващо покритие за newline,
неизвестни auth/cookie headers и missing-dist/incremental-cache сценария.
Няма потвърден пряк host/sandbox escape или достижим външен destructive-delete
път от тези 12 констатации. Продуктов код, настройки и данни не са променяни.

## Приоритет за последваща поправка

1. Да се изключват incremental build caches заедно с build outputs при QA import.
2. Да се допълни общото заличаване на auth/cookie форми с реални regression cases.
3. Да се коригира newline/control-character gate за replay.
4. Да се уточни и приложи правилото за ambiguous merge selection.

Останалите defensive проверки са отделни малки задачи. №9, №10 и неработеща
real-sandbox среда не следва да се броят като три независими дефекта в продукта.
