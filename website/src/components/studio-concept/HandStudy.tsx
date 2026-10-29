import styles from './studio.module.css';
export function HandStudy({open = false}: {open?: boolean}) {
  return <svg className={styles.hand} viewBox="0 0 300 310" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M107 287c-4-29-14-39-22-57L53 172c-6-14 5-22 15-12l29 35-15-94c-3-17 12-19 16-4l20 72-2-121c0-17 15-18 17-1l8 116 15-133c2-17 17-15 16 2l-5 132 23-107c4-16 19-12 15 5l-19 123 27-43c10-15 24-7 16 8l-35 70c-10 20-8 40-17 72l-2 10"/>
      <path d="M118 210c8-19 23-29 43-35m-44 28c5 25 21 37 44 45m-30-29c15-5 26-4 39 0m-75-28 8 20m44-37-1 13m18-9-4 12M109 282l55 5" opacity=".45"/>
      <path d={open ? 'M57 73C20 117 18 177 48 224M234 64c35 32 48 83 29 132' : 'M52 83C27 111 20 141 29 177M234 86c24 25 33 56 23 86'} strokeDasharray="3 6" opacity=".5"/>
      <circle cx="155" cy="151" r={open ? '47' : '30'} stroke="#A77D68" strokeWidth=".8" opacity=".65"/>
      <path d="m240 221 30 7m-25-2 2-7m0 7 5 7M44 52l19 13m-5-10 5 10-11-1" stroke="#A77D68"/>
    </g>
    <g fill="currentColor" fontFamily="Georgia,serif" fontSize="11" fontStyle="italic" opacity=".7"><text x="196" y="253">intention?</text><text x="18" y="40">a small vocabulary</text></g>
  </svg>;
}
