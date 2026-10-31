const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export function HttpMethodOptions() {
  return HTTP_METHODS.map((method) => (
    <option key={method} value={method}>
      {method}
    </option>
  ));
}
