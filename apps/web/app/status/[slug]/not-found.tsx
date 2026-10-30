import Image from 'next/image';

export default function StatusPageNotFound() {
  return (
    <main
      data-watchrail-workspace
      className="grid min-h-svh w-full place-items-center bg-rail-canvas px-5 text-rail-text"
    >
      <div className="w-full max-w-md text-center">
        <Image
          src="/watchrail-mark.svg"
          width={36}
          height={36}
          alt=""
          aria-hidden="true"
          className="mx-auto"
        />
        <h1 className="mt-5 mb-0 text-2xl font-semibold tracking-[-0.025em]">
          Status page not found
        </h1>
        <p className="mt-2 mb-0 text-sm text-rail-subtle">
          The status page you&apos;re looking for isn&apos;t available.
        </p>
      </div>
    </main>
  );
}
