import type { Metadata } from 'next';
import styles from './privacy.module.css';

export const metadata: Metadata = {
  title: 'Arthur Studio Privacy Policy',
  description: 'How Arthur Studio handles notes, optional AI requests, and app data on iPhone, iPad, and Mac.',
};

export default function StudioPrivacyPage() {
  return (
    <article className={styles.policy}>
      <h1>Arthur Studio Privacy Policy</h1>
      <p>This policy covers Arthur Studio for iPhone, iPad, and Mac.</p>

      <section>
        <h2>Information stored on your device</h2>
        <p>
          Arthur Studio stores your notes, projects, ideas, connections, revision history, and settings in
          its local app data. You can capture text without an Arthur Studio account or an AI provider
          key. The app stores keys you add in its private app data and sends them to the relevant
          provider to authenticate API requests.
        </p>
      </section>

      <section>
        <h2>Optional AI features</h2>
        <p>
          When you configure an AI provider, Arthur Studio sends the text needed by enabled AI features
          to that provider over HTTPS. Requests may include notes, questions, related ideas, project
          content, and revision history.
        </p>
        <ul>
          <li>
            OpenAI processes requests for organizing notes, answering questions, creating embeddings for
            Semantic Recall, and generating project briefs on Mac. See <a href="https://platform.openai.com/docs/guides/your-data">OpenAI API data controls</a>.
          </li>
          <li>
            If you enable TypeSafe in the evolution workflow, it receives the text and context needed to
            evaluate a proposed change. See <a href="https://typesafe.ai/legal/privacy-policy">TypeSafe’s privacy policy</a> and <a href="https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained">API retention information</a>.
          </li>
        </ul>
        <p>Provider retention depends on the service, endpoint, and settings for your provider account.</p>
      </section>

      <section>
        <h2>Your choices and retention</h2>
        <p>
          To stop future AI requests to a provider, remove its key in Settings. You can also turn off
          optional features such as Semantic Recall and automated evolution in Settings.
          Local data remains on your device until you remove it. Removing a key or clearing local app data
          does not delete information a provider already received. Contact the provider for access or
          deletion requests about data it retains.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>For privacy questions or requests, email <a href="mailto:nikolovkaloan99@gmail.com">nikolovkaloan99@gmail.com</a>.</p>
      </section>
    </article>
  );
}
