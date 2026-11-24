"use client";

import { useEffect, useId, useState } from "react";
import { api, message } from "@/lib/api";
import { ErrorNote } from "./ui";

type Organization = { name: string; email_domain: string };
const other = "__other__";

export function reviewerDetails(form: FormData) {
  return {
    full_name: form.get("full_name"),
    organization: form.get("organization_name") || form.get("organization"),
    email: form.get("email"),
    role_type: form.get("role_type") || null,
  };
}

export function ReviewerFields() {
  const [organization, setOrganization] = useState("");
  const [email, setEmail] = useState("");
  const [organizations, setOrganizations] = useState<Organization[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const organizationId = useId();
  const suffixId = useId();
  useEffect(() => {
    void api<Organization[]>("/v1/reviewer-organizations")
      .then(setOrganizations)
      .catch((error) => setError(message(error)));
  }, []);
  const domain = organizations?.find(
    (entry) => entry.name === organization,
  )?.email_domain;
  const invalidUsername =
    !!domain && !!email && !/^[a-zA-Z0-9._-]+$/.test(email);

  return (
    <>
      <label htmlFor={organizationId}>
        <span id={`${organizationId}-label`}>Organization</span>
        <select
          id={organizationId}
          aria-labelledby={`${organizationId}-label`}
          name="organization"
          value={organization}
          required
          onChange={(event) => {
            const next = event.target.value;
            if (next !== other) setEmail((current) => current.split("@")[0]);
            setOrganization(next);
          }}
        >
          <option value="">
            {organizations || error
              ? "Choose an organization"
              : "Loading organizations…"}
          </option>
          {organizations?.map(({ name }) => (
            <option key={name}>{name}</option>
          ))}
          {organizations && <option value={other}>Other</option>}
        </select>
      </label>
      {error && <ErrorNote text={error} />}
      {organization === other && (
        <label>
          Organization name
          <input
            name="organization_name"
            maxLength={160}
            required
            pattern={String.raw`.*\S.*`}
          />
        </label>
      )}
      {!organization && <p className="hint">Select an organization first</p>}
      {domain && (
        <>
          <label>
            <span>Email username</span>
            <span className="email-domain-field">
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                pattern={String.raw`[a-zA-Z0-9._\-]+`}
                maxLength={253 - domain.length}
                autoCapitalize="none"
                spellCheck={false}
                aria-label="Email username"
                aria-describedby={suffixId}
                aria-invalid={invalidUsername}
                required
              />
              <span className="email-domain-suffix" id={suffixId}>
                @{domain}
              </span>
            </span>
          </label>
          {invalidUsername && (
            <ErrorNote text="Use only letters, numbers, dots, hyphens or underscores before @." />
          )}
          <input type="hidden" name="email" value={`${email}@${domain}`} />
        </>
      )}
      {organization === other && (
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            required
          />
        </label>
      )}
      <label>
        Full name
        <input name="full_name" autoComplete="name" maxLength={160} required />
      </label>
      <label>
        Role type (optional)
        <select name="role_type">
          <option value="">Choose role type</option>
          {[
            "Compliance Officer",
            "Independent Auditor",
            "Buyer Sustainability Team",
          ].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
    </>
  );
}
